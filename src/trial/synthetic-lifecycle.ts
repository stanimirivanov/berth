import { apply, inMemoryState, Plan, Resource, Stack, Stage } from "alchemy";
import * as Provider from "alchemy/Provider";
import type { ResourceLike } from "alchemy/Resource";
import type { StackSpec } from "alchemy/Stack";
import { State } from "alchemy/State";
import * as Effect from "effect/Effect";

/** Fixed marker resource with no provider credentials or remote persistence. */
interface Synthetic
  extends ResourceLike<
    "Berth.Probe",
    { marker: string },
    { marker: string },
    never,
    undefined,
    never
  > {}
const Synthetic = Resource<Synthetic>("Berth.Probe");
/**
 * Runs real Alchemy create, refresh/read and destroy against isolated memory.
 * State is per invocation; successful deletion is not a durable-backend proof.
 * @returns Lifecycle and empty-state evidence without resource or credential payloads.
 * @throws If the planner/provider fails or its five-second Effect budget expires.
 */
export async function runSyntheticLifecycle() {
  let remote: { marker: string } | undefined;
  let reads = 0;
  let creates = 0;
  let deletes = 0;
  const provider = Provider.succeed(Synthetic, {
    list: () => Effect.sync(() => (remote ? [remote] : [])),
    read: () =>
      Effect.sync(() => {
        reads++;
        return remote;
      }),
    reconcile: ({ news }) =>
      Effect.sync(() => {
        creates++;
        remote = { marker: news.marker };
        return remote;
      }),
    delete: () =>
      Effect.sync(() => {
        deletes++;
        remote = undefined;
      }),
  });
  const stack: StackSpec = {
    name: "berth-runtime-probe",
    stage: "probe",
    resources: {},
    bindings: {},
    actions: {},
    output: {},
  };
  const program = Effect.gen(function* () {
    yield* Synthetic("synthetic", { marker: "no-cloud-mutation" });
    yield* apply(yield* Plan.make(stack));
    const created = remote !== undefined;
    yield* apply(yield* Plan.make(stack));
    yield* apply(yield* Plan.destroy({ name: stack.name, stage: stack.stage }));
    const state = yield* yield* State;
    const remaining = yield* state.list({
      stack: stack.name,
      stage: stack.stage,
    });
    return {
      created: created && creates > 0,
      read: reads > 0,
      deleted: remote === undefined && deletes === 1,
      stateEmpty: Object.keys(remaining).length === 0,
    };
  }).pipe(
    Effect.provide(provider),
    Effect.provide(inMemoryState()),
    Effect.provideService(Stack, stack),
    Effect.provideService(Stage, "probe"),
    Effect.timeout("5 seconds"),
  );
  return Effect.runPromise(program);
}
