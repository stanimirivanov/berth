import { createHash } from "node:crypto";
import {
  DefaultRequestSigner,
  SimpleAuthenticationDetailsProvider,
} from "oci-common";
import { Client } from "pg";
import { boundedObjectSdk } from "../providers/oci/client.js";
import { readinessTransport } from "../providers/oci/readiness.js";
import { monitoringTransport } from "../providers/oci/usage.js";
import { runExecutor } from "./executor.js";
import { assertExecutorPrivileges } from "./executor-security.js";
import { executorStore } from "./executor-store.js";
import type { LedgerDatabase } from "./ledger.js";
import {
  admissionStatus,
  liveAdmissionApi,
  meterAdmission,
} from "./live-admission.js";
import type { liveEnvironment } from "./live-environment.js";
import type { LiveAction } from "./live-hosted.js";
import { usageStore } from "./warnings.js";

/** Invocation-local SQL connection; the runtime closes it after all executor work settles. */
export interface LiveDatabase extends LedgerDatabase {
  /** Connect using restricted credentials with bounded timeouts. */
  connect(): Promise<unknown>;
  /** Release the invocation connection, including on uncertain outcomes. */
  end(): Promise<unknown>;
}
/** Local test seams replace only I/O; the ledger, signer and executor remain real. */
export interface LivePorts {
  database?: (connection: string) => LiveDatabase;
  fetch?: typeof fetch;
  /** Local provider fake for SQL integration tests; production always uses signed transport. */
  sdk?: import("./executor.js").ExecutorOptions["sdk"];
}
/** Construct single-send transports; merely constructing a signer dispatches no requests. */
export function liveTransports(
  e: ReturnType<typeof liveEnvironment>,
  fetcher: typeof fetch = fetch,
) {
  const signer = new DefaultRequestSigner(
    new SimpleAuthenticationDetailsProvider(
      e.tenancy,
      e.user,
      e.fingerprint,
      e.privateKey,
      null,
    ),
  );
  return {
    /** Creation cutoff comes from the authoritative ledger snapshot, never a caller payload. */
    sdk: (signal: AbortSignal, creationDeadline: number) =>
      boundedObjectSdk(signer, signal, fetcher, 5000, { creationDeadline }),
    readiness: readinessTransport(
      e.region,
      e.namespace,
      e.compartment,
      signer,
      fetcher,
    ),
    usage: monitoringTransport(e.region, e.compartment, signer, fetcher),
  };
}
/**
 * Execute one fixed admitted operation. Identity/target/window drift fails before
 * claims or provider dispatch; SQL remains the budget and ownership authority.
 * This entry neither admits new trials nor asserts current provider IAM/allowances.
 */
export async function executeLive(
  e: ReturnType<typeof liveEnvironment>,
  action: LiveAction,
  delivery?: string,
  ports: LivePorts = {},
) {
  if (Date.now() < e.startedAt || Date.now() >= e.expiresAt)
    return { phase: "expired" };
  const deadlineAt = Date.now() + 50000;
  return withLiveDatabase(e, ports, async (db, snapshot) => {
    const store = executorStore(db),
      trial = snapshot.trial;
    const status = await admissionStatus(db, e);
    if (
      action !== "scheduled" ||
      (!status.admitted && Date.now() < e.startedAt + 300000)
    )
      await meterAdmission(
        db,
        e,
        action === "scheduled"
          ? "scheduled"
          : action === "cleanup"
            ? "cleanup"
            : "control",
      );
    if (Date.now() >= e.expiresAt) return { phase: "expired" };
    // meter_http atomically persisted the cleanup flag with its single control charge.
    if (action === "cleanup")
      return { operation: e.operation, status: "cleanup-requested" };
    if (action === "usage") return await usageStore(db).report(e.operation);
    if (action === "evidence")
      return {
        operation: e.operation,
        phase: snapshot.phase,
        status: trial.outcome,
        reason: snapshot.reason,
        objectRemoved: snapshot.object_removed,
        startedAt: trial.started_at,
        expiresAt: trial.expires_at,
      };
    if (!delivery) throw Error("Missing delivery");
    if (!status.admitted) {
      if (Date.now() < e.startedAt + 300000)
        return { phase: "awaiting-submission" };
      await store.cleanup(e.operation);
    }
    const transports = liveTransports(e, ports.fetch);
    // Await is essential: finally must not close SQL while the executor is still running.
    /** Deterministic subdeliveries share one hosting deadline and retain SQL replay fencing. */
    const step = (ordinal: number) =>
      runExecutor(db, {
        operation: e.operation,
        delivery: createHash("sha256")
          .update(`${delivery}:${ordinal}`)
          .digest("hex"),
        expiresAt: e.expiresAt,
        deadlineAt,
        usage: transports.usage,
        sdk:
          ports.sdk ??
          ((signal, session) =>
            transports.sdk(signal, session.creationDeadline)),
      });
    const first = await step(0);
    // Replay may have committed bucket creation before losing its response. The
    // second deterministic subdelivery safely resumes upload within the same deadline.
    if (
      ["object", "duplicate"].includes(first.phase) &&
      (await store.report(e.operation)).phase === "object"
    )
      return await step(1);
    return first;
  });
}
/** One restricted connection and exact target/window check shared by admission and continuation. */
async function withLiveDatabase<T>(
  e: ReturnType<typeof liveEnvironment>,
  ports: LivePorts,
  work: (
    db: LiveDatabase,
    snapshot: import("./executor-store.js").ExecutionSnapshot,
  ) => Promise<T>,
): Promise<T> {
  const db = ports.database
    ? ports.database(e.connection)
    : new Client({
        connectionString: e.connection,
        connectionTimeoutMillis: 5000,
        statement_timeout: 5000,
        query_timeout: 6000,
      });
  try {
    await db.connect();
    await assertExecutorPrivileges(db);
    const store = executorStore(db),
      snapshot = await store.report(e.operation),
      trial = snapshot?.trial;
    if (
      !trial ||
      trial.operation !== e.operation ||
      trial.compartment !== e.compartment ||
      trial.namespace !== e.namespace ||
      trial.region !== e.region ||
      Date.parse(trial.started_at) !== e.startedAt ||
      Date.parse(trial.expires_at) !== e.expiresAt
    )
      throw Error("Admitted target or window mismatch");
    return await work(db, snapshot);
  } finally {
    await db.end();
  }
}

/** Signed private admission uses the same prepared operation and SQL connection boundary. */
export async function executeLiveAdmission(
  e: ReturnType<typeof liveEnvironment>,
  request: Request,
  ports: LivePorts = {},
) {
  return withLiveDatabase(e, ports, async (db) => {
    await admissionStatus(db, e);
    await meterAdmission(db, e);
    return liveAdmissionApi(
      db,
      e,
      liveTransports(e, ports.fetch).readiness,
    ).fetch(request);
  });
}
