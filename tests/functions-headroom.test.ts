import assert from "node:assert/strict";
import test from "node:test";
import { qualifyFunctions } from "../scripts/functions-headroom.js";

const now = Date.parse("2026-11-15T12:00:00Z");
const input = {
  checkedAt: now,
  probe: { clientMs: 2252, handlerMs: 1547, unit: "milliseconds" },
  history: {
    source: "provider-meter",
    complete: true,
    truncated: false,
    unit: "capacity-seconds",
    covers: [
      "accepted",
      "rejected",
      "load-failure",
      "retry",
      "expired",
      "post-response",
    ],
    observations: [
      {
        id: "period-total",
        active: 3600,
        waiting: 7200,
        invocations: 100,
        transferBytes: 1000,
      },
    ],
  },
};

test("Functions qualification keeps units and cleanup margin explicit without granting admission", () => {
  const r = qualifyFunctions(input, now);
  assert.equal(r.verdict, "review-required");
  assert.deepEqual(r.remaining, {
    activeCapacitySeconds: 32400,
    waitingCapacitySeconds: 1432800,
    invocations: 999900,
  });
  assert.equal(r.plan.applicationCalls, 64);
  assert.equal(r.plan.cleanupCalls, 12);
  assert.equal(r.plan.perCallSeconds, 60);
  assert.equal(r.plan.totalCapacitySeconds, 6000);
  assert.equal(r.plan.shutdownMinutes, 15);
  assert.equal(r.admission, false);
  assert.ok(!("neonComputeSeconds" in r));
});

test("Functions qualification rejects missing truncated stale mixed-unit and duplicate evidence", () => {
  for (const value of [
    undefined,
    { ...input, checkedAt: now - 86400001 },
    { ...input, checkedAt: now + 1 },
    { ...input, history: undefined },
    { ...input, history: { ...input.history, complete: false } },
    { ...input, history: { ...input.history, truncated: true } },
    { ...input, history: { ...input.history, source: "client-log" } },
    { ...input, history: { ...input.history, unit: "CU-hours" } },
    { ...input, history: { ...input.history, covers: ["accepted"] } },
    {
      ...input,
      history: {
        ...input.history,
        observations: [
          input.history.observations[0],
          input.history.observations[0],
        ],
      },
    },
    { ...input, history: { ...input.history, observations: [] } },
    { ...input, probe: { ...input.probe, unit: "seconds" } },
    { ...input, probe: { ...input.probe, handlerMs: 0 } },
  ]) {
    const r = qualifyFunctions(value, now);
    assert.equal(r.verdict, "no-go");
    assert.equal(r.remaining, null);
    assert.equal(r.admission, false);
  }
});

test("Functions qualification reserves complete cleanup and rejects unsafe numeric totals", () => {
  for (const active of [30001, -1, NaN, Infinity]) {
    const r = qualifyFunctions(
      {
        ...input,
        history: {
          ...input.history,
          observations: [{ ...input.history.observations[0], active }],
        },
      },
      now,
    );
    assert.equal(r.verdict, "no-go");
  }
  const r = qualifyFunctions(
    { ...input, probe: { ...input.probe, clientMs: 61000 } },
    now,
  );
  assert.equal(r.verdict, "no-go");
});

test("Functions report cannot mutate the shared cleanup planning reserve", () => {
  const r = qualifyFunctions(input, now);
  assert.throws(() => Object.assign(r.plan, { cleanupCalls: 0 }));
  assert.equal(qualifyFunctions(input, now).plan.cleanupCalls, 12);
});

test("Functions qualification rejects exhaustion in each separate meter and accepts exact reserves", () => {
  const atLimit = {
    id: "period-total",
    active: 30000,
    waiting: 1434000,
    invocations: 999900,
    transferBytes: 1000,
  };
  const evaluate = (row: unknown) =>
    qualifyFunctions(
      { ...input, history: { ...input.history, observations: [row] } },
      now,
    );
  assert.equal(evaluate(atLimit).verdict, "review-required");
  for (const change of [
    { active: 30001 },
    { waiting: 1434001 },
    { invocations: 999901 },
    { invocations: 1.5 },
    { transferBytes: -1 },
    { active: "30000" },
  ])
    assert.equal(evaluate({ ...atLimit, ...change }).verdict, "no-go");
});
