import assert from "node:assert/strict";
import test from "node:test";
import { scheduledHandler } from "../src/trial/scheduled.js";

const start = Date.parse("2026-11-13T10:00:00Z");
function delivery(at = start, id = "delivery-1") {
  return new Request("https://trial.invalid/scheduled", {
    method: "POST",
    headers: { "x-neon-trigger-invocation-id": id },
    body: JSON.stringify({
      version: 1,
      invocation_id: id,
      trigger: { id: "schedule", type: "schedule" },
      data: { scheduled_at: new Date(at).toISOString() },
    }),
  });
}
test("expired scheduled deliveries never open database or cloud connections", async () => {
  let calls = 0;
  const handler = scheduledHandler({
    startedAt: start,
    expiresAt: start + 14400000,
    now: () => start + 14400000,
    run: async () => {
      calls++;
      return "done";
    },
  });
  assert.equal((await handler.fetch(delivery())).status, 200);
  assert.equal(calls, 0);
});
test("only attested bounded recent scheduled envelopes reach continuation", async () => {
  let calls = 0;
  const handler = scheduledHandler({
    startedAt: start,
    expiresAt: start + 14400000,
    now: () => start + 900000,
    run: async () => {
      calls++;
      return "object";
    },
  });
  assert.equal(
    (
      await handler.fetch(
        new Request("https://trial.invalid/scheduled", { method: "POST" }),
      )
    ).status,
    401,
  );
  assert.equal((await handler.fetch(delivery(start + 900000))).status, 200);
  assert.equal(calls, 1);
  assert.equal((await handler.fetch(delivery(start + 900001))).status, 400);
  assert.equal((await handler.fetch(delivery(start - 900000))).status, 400);
  assert.equal(calls, 1);
});
