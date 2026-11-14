import { apply, Plan, Stack, Stage } from "alchemy";
import type { StackSpec } from "alchemy/Stack";
import {
  type PersistedState,
  State,
  type StateService,
  StateStoreError,
} from "alchemy/State/State";
import * as Effect from "effect/Effect";
import {
  type BucketAttributes,
  bucketProvider,
  OciBucket,
} from "../providers/oci/bucket.js";
import type { BucketClient, BucketIntent } from "../providers/oci/client.js";
import type { executorStore } from "./executor-store.js";
import type { LedgerClaim } from "./ledger.js";

/** Actual Alchemy plan/apply against a single bucket state fenced by the ledger generation. */
export async function bucketLifecycle(
  store: ReturnType<typeof executorStore>,
  claim: LedgerClaim,
  intent: BucketIntent,
  client: BucketClient,
  destroy = false,
) {
  /** No reacquisition or cached state: every persistent operation crosses the SQL fence. */
  const call = <T>(command: string, value: unknown = null) =>
    Effect.tryPromise({
      try: () => store.access<T>(claim, command, value),
      catch: () =>
        new StateStoreError({ message: "Executor state unavailable" }),
    });
  const stack: StackSpec = {
    name: "berth-oci-trial",
    stage: claim.operation,
    resources: {},
    bindings: {},
    actions: {},
    output: {},
  };
  /** Refuse another engine target even if a caller supplies well-formed state. */
  const target = (request: { stack: string; stage?: string; fqn?: string }) => {
    if (
      request.stack !== stack.name ||
      (request.stage !== undefined && request.stage !== stack.stage) ||
      (request.fqn !== undefined && request.fqn !== "bucket")
    )
      throw Error("State target rejected");
  };
  const get = () => call<PersistedState | null>("get-state");
  const state: StateService = {
    id: "berth-executor-fenced",
    getVersion: () => Effect.succeed(1),
    listStacks: () => get().pipe(Effect.map((s) => (s ? [stack.name] : []))),
    listStages: (name) => {
      target({ stack: name });
      return get().pipe(Effect.map((s) => (s ? [stack.stage] : [])));
    },
    get: (r) => {
      target(r);
      return get().pipe(Effect.map((s) => s ?? undefined));
    },
    getReplacedResources: (r) => {
      target(r);
      return get().pipe(Effect.as([]));
    },
    set: (r) => {
      target(r);
      return call("set-state", r.value).pipe(Effect.as(r.value));
    },
    delete: (r) => {
      target(r);
      return call("delete-state").pipe(Effect.asVoid);
    },
    deleteStack: (r) => {
      target(r);
      return call("delete-state").pipe(Effect.asVoid);
    },
    list: (r) => {
      target(r);
      return get().pipe(Effect.map((s) => (s ? ["bucket"] : [])));
    },
    getOutput: (r) => {
      target(r);
      return get().pipe(Effect.as({}));
    },
    setOutput: (r) => {
      target(r);
      if (JSON.stringify(r.value) !== "{}") throw Error("Output rejected");
      return get().pipe(Effect.as(r.value));
    },
  };
  const program = Effect.gen(function* () {
    if (destroy) {
      yield* apply(
        yield* Plan.destroy({ name: stack.name, stage: stack.stage }),
      );
      return;
    }
    yield* OciBucket("bucket", { operation: claim.operation });
    yield* apply(yield* Plan.make(stack));
  }).pipe(
    Effect.provide(bucketProvider(intent, client, destroy)),
    Effect.provideService(State, Effect.succeed(state)),
    Effect.provideService(Stack, stack),
    Effect.provideService(Stage, stack.stage),
  );
  await Effect.runPromise(program);
  if (!destroy) {
    const row = await store.access<PersistedState>(claim, "get-state");
    if (!row || !("attr" in row)) throw Error("Missing bucket identity");
    await store.access(claim, "bucket", row.attr as BucketAttributes);
  }
}
