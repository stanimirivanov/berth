import assert from "node:assert/strict";
import test from "node:test";
import {
  makeTrialTransport,
  workerMetadata,
} from "../scripts/cloudflare-trial.js";

test("Cloudflare trial reserves requests before dispatch and preserves cleanup capacity", async () => {
  const events: string[] = [];
  let calls = 0;
  const transport = makeTrialTransport({
    account: "a".repeat(32),
    token: "synthetic",
    journal: async (event) => {
      events.push(event.phase);
    },
    fetch: async () => {
      calls++;
      return Response.json({ success: true, result: [] });
    },
    limit: 3,
    cleanupReserve: 1,
  });
  await transport.request("GET", "/workers/scripts");
  await transport.request("GET", "/workers/scripts");
  await assert.rejects(transport.request("GET", "/workers/scripts"), /budget/);
  assert.equal(calls, 2);
  await transport.request("GET", "/workers/scripts", undefined, true);
  assert.equal(calls, 3);
  assert.deepEqual(events, [
    "intent",
    "response",
    "intent",
    "response",
    "intent",
    "response",
  ]);
});

test("Cloudflare trial rejects credential forwarding, redirects and uncertain mutation retries", async () => {
  let calls = 0;
  const transport = makeTrialTransport({
    account: "a".repeat(32),
    token: "synthetic",
    journal: async () => {},
    fetch: async (_url, init) => {
      calls++;
      assert.equal(init?.redirect, "error");
      throw Error("private provider detail");
    },
  });
  await assert.rejects(transport.request("GET", "//attacker.invalid"), /scope/);
  await assert.rejects(
    transport.request("POST", "/secrets_store/stores", { name: "trial" }),
    /^Error: Cloudflare request outcome uncertain$/,
  );
  await assert.rejects(
    transport.request("POST", "/secrets_store/stores", { name: "trial" }),
    /already dispatched/,
  );
  assert.equal(calls, 1);
  const blocked = makeTrialTransport({
    account: "a".repeat(32),
    token: "synthetic",
    journal: async () => {
      throw Error("journal failed");
    },
    fetch: async () => {
      calls++;
      return Response.json({});
    },
  });
  await assert.rejects(
    blocked.request("GET", "/workers/scripts"),
    /journal failed/,
  );
  assert.equal(calls, 1);
});

test("Cloudflare metadata selects SQLite and binds secrets without embedding values", () => {
  const metadata = workerMetadata(
    "berth-state-trial",
    "a".repeat(32),
    "b".repeat(32),
  );
  assert.deepEqual(metadata.exports, {
    Store: { type: "durable-object", storage: "sqlite" },
  });
  assert.equal(
    metadata.bindings.filter((x) => x.type === "secrets_store_secret").length,
    2,
  );
  assert.equal(
    JSON.stringify(metadata).includes("synthetic-secret-value"),
    false,
  );
  assert.throws(
    () => workerMetadata("alchemy-state-store", "a".repeat(32), "b".repeat(32)),
    /name/,
  );
});

test("teardown permits force only for the dedicated trial Worker", async () => {
  let calls = 0;
  const transport = makeTrialTransport({
    account: "a".repeat(32),
    token: "synthetic",
    journal: async () => {},
    fetch: async () => {
      calls++;
      return Response.json({ success: true, result: null });
    },
  });
  await transport.request(
    "DELETE",
    "/workers/scripts/berth-state-trial?force=true",
    undefined,
    true,
  );
  await assert.rejects(
    transport.request(
      "DELETE",
      "/workers/scripts/other?force=true",
      undefined,
      true,
    ),
    /scope/,
  );
  assert.equal(calls, 1);
});

test("concurrent calls cannot overspend while the intent journal is pending", async () => {
  let release: () => void = () => {};
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const transport = makeTrialTransport({
    account: "a".repeat(32),
    token: "synthetic",
    limit: 2,
    cleanupReserve: 1,
    journal: async () => pending,
    fetch: async () => {
      calls++;
      return Response.json({ success: true, result: [] });
    },
  });
  const first = transport.request("GET", "/workers/scripts");
  const second = transport.request("GET", "/workers/scripts");
  release();
  const outcomes = await Promise.allSettled([first, second]);
  assert.equal(outcomes.filter((x) => x.status === "rejected").length, 1);
  assert.equal(calls, 1);
});

test("reloaded journal retains uncertain mutations and cleanup-only remaining allowance", async () => {
  const transport = makeTrialTransport({
    account: "a".repeat(32),
    token: "synthetic",
    limit: 2,
    cleanupReserve: 1,
    prior: [{ phase: "intent", method: "POST", path: "/secrets_store/stores" }],
    journal: async () => {},
    fetch: async () => Response.json({ success: true, result: [] }),
  });
  await assert.rejects(
    transport.request("POST", "/secrets_store/stores", {}),
    /already dispatched/,
  );
  await assert.rejects(transport.request("GET", "/workers/scripts"), /budget/);
  await transport.request("GET", "/workers/scripts", undefined, true);
  assert.equal(transport.count(), 2);
});
