import assert from "node:assert/strict";
import test from "node:test";
import { makeProbe } from "../src/trial/runtime-probe.js";
import { runSyntheticLifecycle } from "../src/trial/synthetic-lifecycle.js";

test("actual Alchemy planner/apply creates, reads and destroys an isolated synthetic resource", async () => {
  const result = await runSyntheticLifecycle();
  assert.equal(result.created, true);
  assert.equal(result.read, true);
  assert.equal(result.deleted, true);
  assert.equal(result.stateEmpty, true);
});
test("manual authentication, expiry and fixed routes prevent protected work", async () => {
  let calls = 0;
  const handler = makeProbe({
    token: "a".repeat(43),
    expiresAt: Date.now() + 60000,
    run: async () => {
      calls++;
      return { ok: true };
    },
  });
  for (const headers of [
    {},
    { authorization: "Bearer wrong" },
    { "x-neon-trigger-invocation-id": "forged" },
  ]) {
    assert.equal(
      (
        await handler.fetch(
          new Request("https://probe.test/", { method: "POST", headers }),
        )
      ).status,
      401,
    );
  }
  assert.equal(calls, 0);
  assert.equal(
    (
      await handler.fetch(
        new Request("https://probe.test/", {
          method: "POST",
          headers: { authorization: `Bearer ${"a".repeat(43)}` },
        }),
      )
    ).status,
    200,
  );
  assert.equal(calls, 1);
  const expired = makeProbe({
    token: "a".repeat(43),
    expiresAt: 0,
    run: async () => {
      throw new Error("must not run");
    },
  });
  assert.equal(
    (
      await expired.fetch(
        new Request("https://probe.test/", { method: "POST" }),
      )
    ).status,
    410,
  );
});

test("scheduler validates envelope, records stable duplicate ids and expires without work", async () => {
  const handler = makeProbe({
    token: "a".repeat(43),
    expiresAt: Date.now() + 60000,
    run: async () => {
      throw new Error("scheduler must never run lifecycle");
    },
  });
  const body = {
    version: 1,
    invocation_id: "occurrence",
    trigger: { type: "schedule", id: "trigger-test" },
    data: { scheduled_at: new Date().toISOString() },
  };
  const req = (header: string) =>
    new Request("https://probe.test/scheduled", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-neon-trigger-invocation-id": header,
      },
      body: JSON.stringify(body),
    });
  assert.equal((await handler.fetch(req("different"))).status, 401);
  assert.equal((await handler.fetch(req("occurrence"))).status, 503);
  const second = await handler.fetch(req("occurrence"));
  assert.equal(second.status, 200);
  assert.equal((await second.json()).duplicate, true);
  const expired = makeProbe({
    token: "a".repeat(43),
    expiresAt: 0,
    run: async () => {
      throw new Error("expired");
    },
  });
  assert.equal((await expired.fetch(req("occurrence"))).status, 200);
});

test("deployment environment overrides both owner URLs and excludes administrator secrets", async () => {
  const { deploymentEnvironment } = await import("../src/trial/deployment.js");
  const credentials = {
    DATABASE_URL:
      "postgresql://berth_runtime:secret@ep-test.us-east-2.aws.neon.tech/neondb?sslmode=verify-full",
    DATABASE_URL_UNPOOLED:
      "postgresql://berth_runtime:secret@ep-test.us-east-2.aws.neon.tech/neondb?sslmode=verify-full",
    BERTH_TRIAL_TOKEN: "x".repeat(43),
    NEON_API_KEY: "must-not-deploy",
  };
  const env = deploymentEnvironment(
    credentials,
    "a".repeat(64),
    Date.now() + 60000,
  );
  assert.equal(env.DATABASE_URL, credentials.DATABASE_URL);
  assert.equal(env.DATABASE_URL_UNPOOLED, credentials.DATABASE_URL_UNPOOLED);
  assert.equal(Object.keys(env).length, 8);
  for (const key of [
    "NEON_AI_GATEWAY_TOKEN",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
  ])
    assert.equal(env[key], "disabled-for-berth-probe");
  assert.ok(!JSON.stringify(env).includes("must-not-deploy"));
  assert.throws(() =>
    deploymentEnvironment(
      {
        ...credentials,
        DATABASE_URL: credentials.DATABASE_URL.replace(
          "berth_runtime",
          "neondb_owner",
        ),
      },
      "a".repeat(64),
      Date.now() + 60000,
    ),
  );
  assert.throws(() =>
    deploymentEnvironment(credentials, "a".repeat(64), Date.now() + 3600000),
  );
});

test("protected errors are redacted and arbitrary targets are rejected", async () => {
  const handler = makeProbe({
    token: "x".repeat(43),
    expiresAt: Date.now() + 60000,
    run: async () => {
      throw new Error("secret-token");
    },
  });
  const request = (path: string, body?: string) =>
    new Request(`https://probe.test${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${"x".repeat(43)}` },
      ...(body ? { body } : {}),
    });
  assert.equal((await handler.fetch(request("/?target=other"))).status, 404);
  assert.equal(
    (await handler.fetch(request("/", '{"action":"destroy"}'))).status,
    400,
  );
  const result = await handler.fetch(request("/"));
  assert.equal(result.status, 500);
  assert.equal(await result.text(), '{"error":"probe-failed"}');
});

test("Neon adapter's empty POST stream is accepted without accepting input", async () => {
  const handler = makeProbe({
    token: "x".repeat(43),
    expiresAt: Date.now() + 60000,
    run: async () => ({ ok: true }),
  });
  const response = await handler.fetch(
    new Request("https://probe.test/", {
      method: "POST",
      headers: { authorization: `Bearer ${"x".repeat(43)}` },
      body: "",
    }),
  );
  assert.equal(response.status, 200);
});

test("probe failures expose only a controlled stage, never provider error text", async () => {
  const { ProbeFailure } = await import("../src/trial/runtime-probe.js");
  const handler = makeProbe({
    token: "x".repeat(43),
    expiresAt: Date.now() + 60000,
    run: async () => {
      throw new ProbeFailure("database");
    },
  });
  const r = await handler.fetch(
    new Request("https://probe.test/", {
      method: "POST",
      headers: { authorization: `Bearer ${"x".repeat(43)}` },
    }),
  );
  assert.deepEqual(await r.json(), {
    error: "probe-failed",
    stage: "database",
  });
});

test("fixed timeout experiment requires auth and cancels its timer without protected work", async () => {
  const handler = makeProbe({
    token: "x".repeat(43),
    expiresAt: Date.now() + 60000,
    run: async () => {
      throw new Error("must not run");
    },
  });
  const request = (auth: boolean) =>
    new Request("https://probe.test/timeout", {
      method: "POST",
      headers: auth ? { authorization: `Bearer ${"x".repeat(43)}` } : {},
    });
  assert.equal((await handler.fetch(request(false))).status, 401);
  const response = await handler.fetch(request(true));
  assert.equal(response.status, 504);
  assert.equal((await response.json()).timerAborted, true);
});
