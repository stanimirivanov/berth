import { randomUUID } from "node:crypto";
import * as Effect from "effect/Effect";
import { lifecycle } from "./fenced-lifecycle.js";
import {
  claimState,
  makeFencedState,
  type StateDatabase,
} from "./fenced-state.js";

/** Two-step synthetic proof only; an incomplete intent requires inspection, never replay. */
export async function runCheckpoint(
  db: StateDatabase,
  idHash: string,
  boot: string,
) {
  const report = (await db.query("SELECT berth_state.probe_report() AS report"))
    .rows[0]?.report;
  if (
    report &&
    typeof report === "object" &&
    "terminal" in report &&
    report.terminal === true
  )
    return { phase: "terminal" };
  const claim = await claimState(db, randomUUID(), 30);
  const adapter = makeFencedState(db, claim);
  const values = [claim.owner, claim.generation, idHash, boot];
  const req = { stack: "berth-fenced-trial", stage: "probe", fqn: "synthetic" };
  try {
    const phase = (
      await db.query(
        "SELECT berth_state.probe_step($1,$2,$3,$4) AS phase",
        values,
      )
    ).rows[0]?.phase;
    if (phase === "duplicate" || phase === "terminal") return { phase };
    if (phase === "first") {
      if (await Effect.runPromise(adapter.state.get(req)))
        throw Error("Unexpected state");
      await lifecycle(adapter.state, "first");
    } else if (phase === "finish") {
      const previous = await Effect.runPromise(adapter.state.get(req));
      if (
        !previous ||
        !("attr" in previous) ||
        JSON.stringify(previous.attr) !== JSON.stringify({ marker: "first" })
      )
        throw Error("Missing durable state");
      await lifecycle(adapter.state, "second");
      const updated = await Effect.runPromise(adapter.state.get(req));
      if (
        !updated ||
        !("attr" in updated) ||
        JSON.stringify(updated.attr) !== JSON.stringify({ marker: "second" })
      )
        throw Error("Update not persisted");
      await lifecycle(adapter.state, "destroy");
      if ((await Effect.runPromise(adapter.state.list(req))).length)
        throw Error("Nonempty state");
    } else throw Error("Unexpected phase");
    await db.query("SELECT berth_state.probe_step($1,$2,$3,$4,true)", values);
    return { phase };
  } finally {
    await Effect.runPromise(adapter.release());
  }
}
