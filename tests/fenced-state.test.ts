import assert from "node:assert/strict";
import test from "node:test";
import * as Effect from "effect/Effect";
import { claimState, makeFencedState } from "../src/trial/fenced-state.js";

test("fenced adapter captures ownership and never reacquires on uncertain writes", async () => {
  const calls: unknown[][] = [];
  const claim = {
    owner: "00000000-0000-4000-8000-000000000001",
    generation: "1",
  };
  const adapter = makeFencedState(
    {
      query: async (_sql, values) => {
        calls.push(values ?? []);
        throw Error("private provider canary");
      },
    },
    claim,
  );
  claim.generation = "2";
  await assert.rejects(
    Effect.runPromise(
      adapter.state.deleteStack({
        stack: "berth-fenced-trial",
        stage: "probe",
      }),
    ),
    (error) =>
      String(error).includes("uncertain") && !String(error).includes("canary"),
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.[1], "1");
  assert.equal(calls[0]?.[2], "clear");
  await assert.rejects(
    Effect.runPromise(adapter.state.list({ stack: "foreign", stage: "probe" })),
    /Unsupported/,
  );
  assert.equal(calls.length, 1);
});

test("claim validates UUID and TTL before dispatch and sanitizes failures", async () => {
  let calls = 0;
  const db = {
    query: async () => {
      calls++;
      throw Error("private canary");
    },
  };
  await assert.rejects(
    claimState(db, "------------------------------------"),
    /Invalid/,
  );
  await assert.rejects(
    claimState(db, "00000000-0000-4000-8000-000000000001", 61),
    /Invalid/,
  );
  assert.equal(calls, 0);
  await assert.rejects(
    claimState(db, "00000000-0000-4000-8000-000000000001"),
    (error) =>
      String(error).includes("unavailable") &&
      !String(error).includes("canary"),
  );
  assert.equal(calls, 1);
});
