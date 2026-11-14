import assert from "node:assert/strict";
import test from "node:test";
import { writeBoundary } from "./fakes/faults.js";

test("fault inventory names writes without exposing arguments and excludes pure reads", () => {
  assert.equal(
    writeBoundary("SELECT berth_executor.access($1,$2,$3,$4,$5)", [
      "op",
      "owner",
      1,
      "set-state",
      JSON.stringify({ status: "created", secret: "canary" }),
    ]),
    "executor.set-state:created",
  );
  assert.equal(
    writeBoundary("SELECT berth_executor.access($1,$2,$3,$4,$5)", [
      "op",
      "owner",
      1,
      "get-state",
    ]),
    null,
  );
  assert.equal(
    writeBoundary("SELECT berth_usage.control($1,$2,$3,$4,$5)", [
      "op",
      "owner",
      1,
      "allowed",
    ]),
    null,
  );
  assert.equal(
    writeBoundary("SELECT berth_usage.control($1,$2,$3,$4,$5)", [
      "op",
      "owner",
      1,
      "record",
    ]),
    "usage.record",
  );
  assert.throws(() => writeBoundary("DELETE FROM other", []));
});

test("independent provider refuses unreserved, reused and wrongly metered requests before effects", async (t) => {
  const { Client } = await import("pg");
  const { cloudService } = await import("./fakes/faults.js");
  const owner = new Client();
  let row: Record<string, unknown> | undefined = {
    id: "r1",
    outcome: "unresolved",
    generation: 1,
    action: "monitor",
    meter: "monitoring",
  };
  t.mock.method(owner, "query", async () => ({ rows: row ? [row] : [] }));
  const cloud = await cloudService(owner);
  const send = () =>
    fetch(cloud.url, {
      method: "POST",
      body: JSON.stringify({
        method: "monitor",
        input: {},
        noRetry: true,
        reservation: {
          id: row?.id ?? "missing",
          action: "monitor",
          generation: "1",
        },
      }),
    });
  try {
    assert.equal((await send()).status, 200);
    assert.equal((await send()).status, 500);
    for (const change of [
      { outcome: "succeeded" },
      { generation: 2 },
      { action: "inspect" },
      { meter: "normal" },
    ]) {
      row = {
        id: "r2",
        outcome: "unresolved",
        generation: 1,
        action: "monitor",
        meter: "monitoring",
        ...change,
      };
      assert.equal((await send()).status, 500);
    }
    row = undefined;
    assert.equal((await send()).status, 500);
    assert.equal(cloud.received.length, 1);
    assert.equal(cloud.violations.length, 6);
    assert.equal(cloud.sdk.creates, 0);
  } finally {
    await cloud.close();
  }
});

test("checkpoint outcome oracle rejects arbitrary stops and requires terminal recovery after provider success", async () => {
  const { classifyRecovery } = await import("./fakes/faults.js");
  const row = {
    outcome: "needs-reconciliation",
    unknown: 1,
    cleanup_used: 0,
    failed: true,
    reason: "unresolved-provider-call",
  };
  assert.equal(classifyRecovery("before:cloud.createBucket", row), "uncertain");
  assert.throws(() => classifyRecovery("after:cloud.createBucket", row));
  assert.throws(() =>
    classifyRecovery("before:cloud.createBucket", {
      ...row,
      outcome: "active",
    }),
  );
  assert.throws(() =>
    classifyRecovery("before:ledger.begin:delete_object", {
      ...row,
      unknown: 0,
    }),
  );
  for (const label of [
    "before:ledger.begin:delete_object",
    "after:ledger.begin:delete_object",
    "before:ledger.reserve:delete_object",
  ]) {
    assert.throws(() =>
      classifyRecovery(label, { ...row, unknown: 0, cleanup_used: 40 }),
    );
    assert.equal(
      classifyRecovery(label, { ...row, outcome: "succeeded", unknown: 0 }),
      "terminal",
    );
  }
  assert.equal(
    classifyRecovery("after:cloud.createBucket", {
      ...row,
      outcome: "succeeded",
      unknown: 0,
    }),
    "terminal",
  );
});
