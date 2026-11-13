import assert from "node:assert/strict";
import test from "node:test";
import { makeStateProbe, runStatePhase } from "../src/trial/state-probe.js";

test("state probe authenticates and expires before protected work", async () => {
  let calls = 0;
  const handler = makeStateProbe({
    token: "synthetic-auth",
    expiresAt: Date.now() + 60000,
    run: async () => {
      calls++;
      return { marker: "first", requests: 1 };
    },
  });
  assert.equal(
    (await handler(new Request("https://probe.test/read", { method: "POST" })))
      .status,
    401,
  );
  assert.equal(
    (
      await handler(
        new Request("https://probe.test/arbitrary", {
          method: "POST",
          headers: { Authorization: "Bearer synthetic-auth" },
        }),
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await handler(
        new Request("https://probe.test/read", {
          method: "POST",
          headers: { Authorization: "Bearer synthetic-auth" },
          body: "x",
        }),
      )
    ).status,
    400,
  );
  assert.equal(calls, 0);
  assert.equal(
    (
      await handler(
        new Request("https://probe.test/read", {
          method: "POST",
          headers: { Authorization: "Bearer synthetic-auth" },
        }),
      )
    ).status,
    200,
  );
  assert.equal(calls, 1);
  const expired = makeStateProbe({
    token: "synthetic-auth",
    expiresAt: 0,
    run: async () => {
      calls++;
      return {};
    },
  });
  assert.equal(
    (
      await expired(
        new Request("https://probe.test/read", {
          method: "POST",
          headers: { Authorization: "Bearer synthetic-auth" },
        }),
      )
    ).status,
    410,
  );
  assert.equal(calls, 1);
});

test("state probe suppresses provider failures and refuses absent configuration", async () => {
  const handler = makeStateProbe({
    token: "synthetic-auth",
    expiresAt: Date.now() + 60000,
    run: async () => {
      throw Error("private-canary");
    },
  });
  const response = await handler(
    new Request("https://probe.test/read", {
      method: "POST",
      headers: { Authorization: "Bearer synthetic-auth" },
    }),
  );
  assert.equal(response.status, 502);
  assert.equal((await response.text()).includes("private-canary"), false);
  assert.throws(() =>
    makeStateProbe({ token: "", expiresAt: NaN, run: async () => ({}) }),
  );
});

test("actual HTTP state adapter persists only fixed synthetic payloads and refuses admin credentials", async () => {
  const originalFetch = globalThis.fetch;
  const keys = [
    "BERTH_STATE_URL",
    "BERTH_STATE_TOKEN",
    "DATABASE_URL",
    "DATABASE_URL_UNPOOLED",
    "CLOUDFLARE_API_TOKEN",
  ];
  const previous = Object.fromEntries(
    keys.map((key) => [key, process.env[key]]),
  );
  let calls = 0;
  let stored: unknown;
  try {
    process.env.BERTH_STATE_URL =
      "https://berth-state-trial.example.workers.dev";
    process.env.BERTH_STATE_TOKEN = "a".repeat(64);
    process.env.DATABASE_URL =
      "postgresql://berth_runtime:test-only@ep-test.us-east-2.aws.neon.tech/neondb?sslmode=verify-full";
    process.env.DATABASE_URL_UNPOOLED = process.env.DATABASE_URL;
    delete process.env.CLOUDFLARE_API_TOKEN;
    globalThis.fetch = async (input, init) => {
      calls++;
      const request = new Request(input, init);
      assert.equal(
        new URL(request.url).hostname,
        "berth-state-trial.example.workers.dev",
      );
      assert.equal(request.redirect, "error");
      if (request.method === "PUT") {
        stored = await request.json();
        assert.equal(JSON.stringify(stored).includes("a".repeat(64)), false);
        assert.equal(JSON.stringify(stored).includes("postgresql"), false);
      }
      return Response.json(stored);
    };
    assert.deepEqual(await runStatePhase("update"), {
      phase: "update",
      marker: "second",
      readMarker: null,
      requests: 2,
      restrictedEnvironment: true,
    });
    assert.equal(calls, 2);
    process.env.CLOUDFLARE_API_TOKEN = "synthetic-admin";
    await assert.rejects(runStatePhase("read"), /Management credential/);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});
