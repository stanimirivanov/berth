import assert from "node:assert/strict";
import test from "node:test";
import { retainedRetryLedger } from "../src/application/retained-trial-ledger/retry.ts";
import { retryActions } from "../src/application/retry/reconciliation.ts";

const operation = "62ebd914-6089-4e41-81a4-75081cb1cef3";
const target = {
  region: "eu-frankfurt-1",
  namespace: "retryfixture",
  compartment: "ocid1.compartment.oc1..fixture",
  bucket: "berth-62ebd91460894e4181a475081cb1cef3",
};

function fixture(reservation: unknown, bucket = target.bucket) {
  const calls: string[] = [];
  const reads: string[] = [];
  const status = {
    operation,
    stage: "checking-provider",
    scope: "after-expiry",
    result: null,
    reason: null,
    ownerProcedure: null,
    observedAt: null,
    startedAt: "2026-11-23T12:00:00Z",
    checks: { used: 0, limit: 2 },
  };
  const action = retryActions(
    retainedRetryLedger({
      async query(sql) {
        const command = /berth_retry\.(\w+)/.exec(sql)?.[1];
        calls.push(command ?? "unknown");
        const result =
          command === "begin"
            ? {
                kind: "claimed",
                target: { ...target, bucket },
                deadline: new Date(Date.now() + 20000).toISOString(),
                status,
              }
            : command === "reserve"
              ? reservation
              : null;
        return { rows: [{ result }] };
      },
    }),
    {
      supports: () => true,
      async observe(scope) {
        reads.push(scope.bucket);
        return { kind: "inconclusive" };
      },
    },
  );
  return { calls, reads, start: () => action("start", operation) };
}

test("only a Boolean true reservation can dispatch a provider read", async () => {
  for (const reservation of ["false", "0", {}, null, undefined]) {
    const check = fixture(reservation);
    await assert.rejects(check.start());
    assert.deepEqual(check.calls, ["begin", "reserve"]);
    assert.deepEqual(check.reads, []);
  }
  const declined = fixture(false);
  await declined.start();
  assert.deepEqual(declined.calls, ["begin", "reserve", "finish"]);
  assert.deepEqual(declined.reads, []);

  const admitted = fixture(true);
  await admitted.start();
  assert.deepEqual(admitted.calls, ["begin", "reserve", "finish"]);
  assert.deepEqual(admitted.reads, [target.bucket]);
});

test("the decoded claim must match the bucket name of the requested operation", async () => {
  const check = fixture(true, `berth-${"a".repeat(32)}`);
  await assert.rejects(check.start(), { message: "Retry target mismatch" });
  assert.deepEqual(check.calls, ["begin"]);
  assert.deepEqual(check.reads, []);
});
