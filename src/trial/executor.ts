import { randomUUID } from "node:crypto";
import { type BucketAttributes, makeBucket } from "../providers/oci/bucket.js";
import {
  BucketFailure,
  type BudgetedDispatcher,
  bucketClient,
  type ObjectSdk,
  objectClient,
} from "../providers/oci/client.js";
import { makeTrialObject, probeIntent } from "../providers/oci/trial-object.js";
import type { UsageTransport } from "../providers/oci/usage.js";
import { bucketLifecycle } from "./executor-resources.js";
import {
  type ExecutionSnapshot,
  executorStore,
  type Phase,
} from "./executor-store.js";
import { type LedgerDatabase, makeLedger, type TrialAction } from "./ledger.js";
import { collectUsage, usageStore } from "./warnings.js";

/** Fixed cadence/deadlines; one minute work plus five-minute delivery margin fits each slot. */
export const timing = {
  cadenceMs: 900000,
  creationMs: 1800000,
  cleanupMs: 10800000,
  expiryMs: 14400000,
  invocationMs: 50000,
  deliveryMarginMs: 300000,
} as const;
/** Pure phase admission, evaluated again at every underlying dispatch. */
export function nextPhase(
  phase: Phase,
  start: number,
  now: number,
  cancelled: boolean,
): Phase | "expired" {
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(now) ||
    now < start ||
    now >= start + timing.expiryMs
  )
    return "expired";
  if (
    cancelled ||
    now >= start + timing.cleanupMs ||
    (now >= start + timing.creationMs &&
      (phase === "bucket" || phase === "object"))
  )
    return "cleanup";
  return phase;
}
/** Durable ledger request projection used only for reconciliation, never dispatch authorization. */
interface RequestRecord {
  id: string;
  attempt: string;
  mutation: boolean;
  outcome: string;
  generation: string;
}
/** Read-only attempts remain open across ticks so the three-attempt cap is not spent per tick. */
interface AttemptRecord {
  id: string;
  action: TrialAction;
  outcome: string;
}
/** One explicit operation; SDK is injected, and must use the supplied deadline AbortSignal. */
export interface ExecutorOptions {
  operation: string;
  delivery: string;
  expiresAt: number;
  now?: () => number;
  /** Shared hosting deadline can shorten, never extend, the per-step work window. */
  deadlineAt?: number;
  /** Optional until the real OCI composition is enabled; omission yields no usage evidence. */
  usage?: UsageTransport;
  sdk: (
    signal: AbortSignal,
    session: {
      claim: import("./ledger.js").LedgerClaim;
      creationDeadline: number;
      snapshot: ExecutionSnapshot;
      store: ReturnType<typeof executorStore>;
    },
  ) => ObjectSdk;
}
/**
 * One bounded scheduled step using real ledger fencing and the narrow providers.
 * Every callback is reserved before send. Unknown writes are never replayed or
 * cleared by lease expiry; absence cannot resolve a possibly late create/upload.
 */
export async function runExecutor(
  db: LedgerDatabase,
  options: ExecutorOptions,
) {
  const clock = options.now ?? Date.now;
  if (
    clock() >= options.expiresAt ||
    (options.deadlineAt !== undefined &&
      (!Number.isFinite(options.deadlineAt) || clock() >= options.deadlineAt))
  )
    return { phase: "expired" };
  const store = executorStore(db),
    ledger = makeLedger(db);
  const opened = await store.open(
    options.operation,
    randomUUID(),
    options.delivery,
  );
  if (opened.kind !== "claimed") return { phase: opened.kind };
  const { claim } = opened;
  let snapshot = opened.snapshot;
  const start = Date.parse(snapshot.trial.started_at),
    expires = Date.parse(snapshot.trial.expires_at),
    deadline = Math.min(
      clock() + timing.invocationMs,
      expires,
      options.deadlineAt ?? Infinity,
    );
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    Math.max(0, deadline - clock()),
  );
  timer.unref();
  /** SQL is authoritative even after local clock checks; renewal never revives an expired owner. */
  async function guard(action: TrialAction) {
    const now = clock();
    if (controller.signal.aborted || now >= deadline || now >= expires)
      throw new BucketFailure("budget");
    if (
      (action === "create_bucket" || action === "put_object") &&
      (snapshot.failed ||
        snapshot.cleanup_requested ||
        snapshot.phase === "cleanup" ||
        now >= start + timing.creationMs)
    )
      throw new BucketFailure("budget");
    if (
      action === "monitor" &&
      (now >= start + timing.cleanupMs ||
        !(await usageStore(db).allowed(claim)))
    )
      throw new BucketFailure("budget");
    await ledger.renew(claim);
    if (action === "monitor" && !(await usageStore(db).allowed(claim)))
      throw new BucketFailure("budget");
    if (
      controller.signal.aborted ||
      clock() >= deadline ||
      clock() >= expires ||
      (action === "monitor" && clock() >= start + timing.cleanupMs) ||
      ((action === "create_bucket" || action === "put_object") &&
        clock() >= start + timing.creationMs)
    )
      throw new BucketFailure("budget");
  }
  /** Re-read the persisted request journal under the captured generation. */
  const journal = () =>
    ledger.read(claim) as Promise<{
      attempts: AttemptRecord[];
      requests: RequestRecord[];
    }>;
  /** Stable open inspection/invocation attempts are resumed; each mutation gets one bounded attempt. */
  async function attempt(action: TrialAction) {
    const j = await journal();
    const old = j.attempts.find(
      (a) =>
        a.action === action &&
        a.outcome === "open" &&
        ![
          "create_bucket",
          "put_object",
          "delete_object",
          "delete_bucket",
        ].includes(action),
    );
    return old?.id ?? (await ledger.begin(claim, randomUUID(), action));
  }
  const dispatcher: BudgetedDispatcher & {
    dispatch<T>(action: TrialAction, send: () => Promise<T>): Promise<T>;
  } = {
    /** Preserve raw transport outcome only long enough to settle definite responses; never log it. */
    async dispatch<T>(action: TrialAction, send: () => Promise<T>): Promise<T> {
      await guard(action);
      const id = await attempt(action),
        request = randomUUID();
      const reservation = await ledger.reserve(claim, id, request);
      if (!reservation.fresh) throw new BucketFailure("budget");
      let started = false;
      try {
        await guard(action);
        started = true;
        const result = await send();
        await ledger.settle(claim, request, "succeeded", "provider-response");
        if (
          [
            "create_bucket",
            "put_object",
            "delete_object",
            "delete_bucket",
          ].includes(action)
        )
          await ledger.end(claim, id, "succeeded");
        return result;
      } catch (error) {
        const status =
          error && typeof error === "object" && "statusCode" in error
            ? error.statusCode
            : undefined;
        if (
          !started ||
          ![
            "create_bucket",
            "put_object",
            "delete_object",
            "delete_bucket",
          ].includes(action) ||
          [400, 401, 403, 409, 412].includes(Number(status))
        ) {
          await ledger.settle(
            claim,
            request,
            "rejected",
            started ? "provider-response" : "not-dispatched",
          );
          if (
            [
              "create_bucket",
              "put_object",
              "delete_object",
              "delete_bucket",
            ].includes(action)
          )
            await ledger.end(claim, id, "failed");
        }
        throw error;
      }
    },
  };
  try {
    if (expires !== options.expiresAt || expires - start !== timing.expiryMs)
      throw Error("Window mismatch");
    await guard("invoke");
    const invoked = await attempt("invoke");
    const invocation = await ledger.reserve(
      claim,
      invoked,
      options.delivery.slice(0, 8) +
        "-" +
        options.delivery.slice(8, 12) +
        "-" +
        options.delivery.slice(12, 16) +
        "-" +
        options.delivery.slice(16, 20) +
        "-" +
        options.delivery.slice(20, 32),
    );
    if (!invocation.fresh) return { phase: "duplicate" };
    await ledger.settle(claim, invocation.id, "succeeded", "provider-response");
    const sdk = options.sdk(controller.signal, {
        claim,
        snapshot,
        store,
        creationDeadline: start + timing.creationMs,
      }),
      client = bucketClient(sdk, dispatcher, snapshot.trial.region),
      objects = objectClient(sdk, dispatcher, snapshot.trial.region);
    const intent = {
      operation: options.operation,
      marker: snapshot.trial.marker,
      bucket: snapshot.trial.bucket,
      compartment: snapshot.trial.compartment,
      namespace: snapshot.trial.namespace,
      region: snapshot.trial.region,
    };
    /** Reconcile only positively observed ownership or a deletion's authenticated absence. */
    async function reconcile() {
      const j = await journal();
      for (const interrupted of j.requests.filter(
        (r) => !r.mutation && r.outcome === "unresolved",
      ))
        await ledger.settle(
          claim,
          interrupted.id,
          "rejected",
          "read-only-interruption",
        );
      const pending = j.requests.filter(
        (r) => r.mutation && r.outcome === "unresolved",
      );
      const create = j.requests.find(
        (r) =>
          j.attempts.find((a) => a.id === r.attempt)?.action ===
            "create_bucket" && r.outcome === "succeeded",
      );
      if (
        !snapshot.bucket &&
        (create ||
          pending.some(
            (r) =>
              j.attempts.find((a) => a.id === r.attempt)?.action ===
              "create_bucket",
          ))
      ) {
        const observed = await client.get(intent, true);
        const candidate: BucketAttributes = {
          id: observed.bucket.id ?? "",
          etag: observed.eTag,
          operation: intent.operation,
          marker: intent.marker,
        };
        await makeBucket(intent, client).read(candidate, true);
        await store.access(claim, "bucket", candidate);
        snapshot = await store.access<ExecutionSnapshot>(claim, "snapshot");
      }
      for (const r of pending) {
        const action = j.attempts.find((a) => a.id === r.attempt)?.action;
        if (action === "create_bucket") {
          if (!snapshot.bucket) throw Error("Unresolved");
        } else if (action === "put_object") {
          if (!snapshot.bucket) throw Error("Unresolved");
          let resolved = false;
          await makeTrialObject(
            {
              intent: probeIntent(intent),
              bucket: snapshot.bucket,
              pending: true,
              ...(snapshot.receipt ? { receipt: snapshot.receipt } : {}),
            },
            objects,
            {
              saveIntent: async () => {
                throw Error("Replay blocked");
              },
              saveReceipt: async (receipt) => {
                await store.access(claim, "receipt", receipt);
              },
            },
          ).remove(async () => {
            await ledger.settle(
              claim,
              r.id,
              "succeeded",
              "reconciled-provider",
            );
            await ledger.end(claim, r.attempt, "succeeded");
            resolved = true;
          });
          if (!resolved) throw Error("Unresolved");
          await store.access(claim, "object-removed");
          continue;
        } else if (action === "delete_object") {
          if (
            !snapshot.bucket ||
            !(await makeBucket(intent, client).read(snapshot.bucket, true))
          )
            throw Error("Unresolved");
          const listing = await objects.list(intent, true),
            versions = await objects.versions(intent, true);
          if (
            listing.listObjects.objects.length ||
            listing.listObjects.nextStartWith ||
            listing.listObjects.prefixes?.length ||
            versions.objectVersionCollection.items.length ||
            versions.opcNextPage
          )
            throw Error("Unresolved");
          await store.access(claim, "object-removed");
        } else if (action === "delete_bucket") {
          const listing = await client.list(intent, true);
          if (listing.items.length || listing.opcNextPage)
            throw Error("Unresolved");
        } else throw Error("Unresolved");
        await ledger.settle(claim, r.id, "succeeded", "reconciled-provider");
        await ledger.end(claim, r.attempt, "succeeded");
      }
      snapshot = await store.access<ExecutionSnapshot>(claim, "snapshot");
    }
    await reconcile();
    const phase = nextPhase(
      snapshot.phase,
      start,
      clock(),
      snapshot.cleanup_requested ||
        snapshot.failed ||
        snapshot.trial.outcome === "needs-reconciliation",
    );
    if (phase === "expired") return { phase };
    if (phase === "bucket") {
      await bucketLifecycle(store, claim, intent, client);
      await store.access(claim, "phase", "object");
      return { phase: "object" };
    }
    if (phase === "object") {
      if (!snapshot.bucket) throw Error("Missing bucket");
      await makeTrialObject(
        {
          intent: probeIntent(intent),
          bucket: snapshot.bucket,
          pending: snapshot.pending_upload,
          ...(snapshot.receipt ? { receipt: snapshot.receipt } : {}),
        },
        objects,
        {
          saveIntent: async () => {
            await store.access(claim, "pending-upload");
          },
          saveReceipt: async (receipt) => {
            await store.access(claim, "receipt", receipt);
          },
        },
      ).upload();
      if (options.usage) {
        await usageStore(db).uploaded(claim);
        await store.access(claim, "phase", "observe");
        return { phase: "observe" };
      }
      await store.access(claim, "phase", "cleanup");
      return { phase: "cleanup" };
    }
    if (phase === "observe") {
      if (options.usage)
        await collectUsage(
          db,
          claim,
          options.usage,
          (send) => dispatcher.dispatch("monitor", send),
          AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(
              Math.max(
                1,
                Math.min(
                  timing.invocationMs,
                  start + timing.cleanupMs - clock(),
                ),
              ),
            ),
          ]),
          clock,
        );
      return { phase };
    }
    if (options.usage) await usageStore(db).close(claim);
    await store.access(claim, "phase", "cleanup");
    snapshot.phase = "cleanup";
    if (snapshot.bucket) {
      if (!snapshot.object_removed) {
        await makeTrialObject(
          {
            intent: probeIntent(intent),
            bucket: snapshot.bucket,
            pending: snapshot.pending_upload,
            ...(snapshot.receipt ? { receipt: snapshot.receipt } : {}),
          },
          objects,
          {
            saveIntent: async () => {
              throw Error("Cleanup cannot upload");
            },
            saveReceipt: async (receipt) => {
              await store.access(claim, "receipt", receipt);
            },
          },
        ).remove();
        await store.access(claim, "object-removed");
      }
      await bucketLifecycle(store, claim, intent, client, true);
    } else {
      const listing = await client.list(intent, true);
      if (listing.items.length || listing.opcNextPage)
        throw Error("Unexpected resources");
    }
    const j = await journal();
    if (j.requests.some((r) => r.outcome === "unresolved"))
      throw Error("Unresolved");
    for (const a of j.attempts.filter((a) => a.outcome === "open"))
      await ledger.end(claim, a.id, "succeeded");
    await ledger.finish(
      claim,
      snapshot.failed || !snapshot.receipt ? "failed" : "succeeded",
    );
    return { phase: "terminal" };
  } catch {
    try {
      await store.access(claim, "failed");
      await store.access(
        claim,
        "reason",
        controller.signal.aborted || clock() >= deadline
          ? "deadline"
          : "unresolved-provider-call",
      );
      await ledger.finish(claim, "needs-reconciliation");
    } catch {
      /* The captured lease may be lost; durable pending requests remain untouched. */
    }
    return { phase: "needs-reconciliation" };
  } finally {
    clearTimeout(timer);
    controller.abort();
    try {
      await ledger.release(claim);
    } catch {
      /* A terminal outcome or lost lease cannot be reacquired here. */
    }
  }
}
