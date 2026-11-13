import { apply, Plan, Resource, Stack, Stage } from "alchemy";
import * as Provider from "alchemy/Provider";
import type { ResourceLike } from "alchemy/Resource";
import type { StackSpec } from "alchemy/Stack";
import { State, type StateService } from "alchemy/State/State";
import * as Effect from "effect/Effect";

interface Synthetic
  extends ResourceLike<
    "Berth.FencedProbe",
    { marker: string },
    { marker: string },
    never,
    undefined,
    never
  > {}
const Synthetic = Resource<Synthetic>("Berth.FencedProbe");
/** Exercise the pinned real engine; echo provider has no remote side effects. */
export async function lifecycle(
  state: StateService,
  mode: "first" | "second" | "destroy",
) {
  const provider = Provider.succeed(Synthetic, {
    version: 1,
    read: ({ output }) => Effect.succeed(output),
    reconcile: ({ news }) => Effect.succeed({ marker: news.marker }),
    delete: () => Effect.void,
  });
  const stack: StackSpec = {
    name: "berth-fenced-trial",
    stage: "probe",
    resources: {},
    bindings: {},
    actions: {},
    output: {},
  };
  const program = Effect.gen(function* () {
    if (mode === "destroy")
      yield* apply(
        yield* Plan.destroy({ name: stack.name, stage: stack.stage }),
      );
    else {
      yield* Synthetic("synthetic", { marker: mode });
      yield* apply(yield* Plan.make(stack));
    }
  }).pipe(
    Effect.provide(provider),
    Effect.provideService(State, Effect.succeed(state)),
    Effect.provideService(Stack, stack),
    Effect.provideService(Stage, "probe"),
    Effect.timeout("10 seconds"),
  );
  await Effect.runPromise(program);
}
