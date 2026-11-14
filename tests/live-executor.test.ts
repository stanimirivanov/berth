import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { liveEnvironment } from "../src/trial/live-environment.js";
import { makeLiveHandler } from "../src/trial/live-hosted.js";

const now = Date.now();
const key = generateKeyPairSync("rsa", { modulusLength: 2048 });
const fingerprint =
  createHash("md5")
    .update(key.publicKey.export({ type: "spki", format: "der" }))
    .digest("hex")
    .match(/../g)
    ?.join(":") ?? "";
const env = {
  DATABASE_URL:
    "postgresql://berth_runtime:fixture@ep-fixture.neon.tech/neondb",
  DATABASE_URL_UNPOOLED:
    "postgresql://berth_runtime:fixture@ep-fixture.neon.tech/neondb",
  BERTH_EXECUTOR_MODE: "live",
  BERTH_PREVIEW_KEY: "b".repeat(40),
  BERTH_MONITORING_LIMIT: "20",
  BERTH_NEON_LIMIT: "40",
  BERTH_EXECUTOR_OPERATION: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  BERTH_EXECUTOR_STARTED_AT: String(now - 1000),
  BERTH_EXECUTOR_EXPIRES_AT: String(now - 1000 + 14400000),
  BERTH_TRIAL_TOKEN: "a".repeat(32),
  OCI_TENANCY_OCID: "ocid1.tenancy.oc1..fixture",
  OCI_USER_OCID: "ocid1.user.oc1..fixture",
  OCI_FINGERPRINT: fingerprint,
  OCI_PRIVATE_KEY: key.privateKey
    .export({ type: "pkcs8", format: "pem" })
    .toString(),
  OCI_REGION: "eu-frankfurt-1",
  OCI_COMPARTMENT_OCID: "ocid1.compartment.oc1..fixture",
  OCI_NAMESPACE: "fixture",
};

test("live environment binds a matching private key and rejects ambient credentials and owner DB URLs", () => {
  assert.equal(liveEnvironment(env).operation, env.BERTH_EXECUTOR_OPERATION);
  for (const patch of [
    { OCI_ADMIN_KEY: "secret" },
    { NEON_API_KEY: "secret" },
    { OCI_FINGERPRINT: `${"00:".repeat(15)}00` },
    {
      OCI_PRIVATE_KEY: key.publicKey
        .export({ type: "spki", format: "pem" })
        .toString(),
    },
    {
      DATABASE_URL:
        "postgresql://neondb_owner:fixture@ep-fixture.neon.tech/neondb",
    },
    { BERTH_EXECUTOR_MODE: "synthetic" },
    { OCI_REGION: "https://attacker.invalid" },
  ])
    assert.throws(() => liveEnvironment({ ...env, ...patch }));
});

test("live handler rejects unauthenticated and expired requests before database or credential parsing", async () => {
  let calls = 0;
  const handler = makeLiveHandler(
    { ...env, OCI_PRIVATE_KEY: "invalid" },
    async () => {
      calls++;
      throw Error("private");
    },
    () => now,
  );
  assert.equal(
    (
      await handler.fetch(
        new Request("https://fixture/evidence", { method: "POST" }),
      )
    ).status,
    401,
  );
  assert.equal(
    (
      await handler.fetch(
        new Request("https://fixture/scheduled", { method: "POST" }),
      )
    ).status,
    401,
  );
  const expired = makeLiveHandler(
    { ...env, BERTH_EXECUTOR_EXPIRES_AT: String(now) },
    async () => {
      calls++;
      throw Error();
    },
    () => now,
  );
  assert.deepEqual(
    await (await expired.fetch(new Request("https://fixture/evidence"))).json(),
    { phase: "expired" },
  );
  assert.equal(calls, 0);
});

test("live handler routes only fixed authenticated actions and redacts failures", async () => {
  const actions: string[] = [];
  const handler = makeLiveHandler(
    env,
    async (_e, action) => {
      actions.push(action);
      if (action === "cleanup") throw Error("private secret");
      return { phase: "bucket" };
    },
    () => now,
  );
  for (const path of ["evidence", "usage", "cleanup"]) {
    const response = await handler.fetch(
      new Request(`https://fixture/${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${env.BERTH_TRIAL_TOKEN}` },
      }),
    );
    assert.equal(response.status, path === "cleanup" ? 503 : 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.ok(!(await response.text()).includes("private secret"));
  }
  assert.deepEqual(actions, ["evidence", "usage", "cleanup"]);
  assert.equal(
    (
      await handler.fetch(
        new Request("https://fixture/submit", { method: "POST" }),
      )
    ).status,
    404,
  );
});

test("live execution checks SQL identity and exact admitted target/window before opening execution", async () => {
  const { executeLive } = await import("../src/trial/live-runtime.js");
  const e = liveEnvironment(env);
  const trial = {
    operation: e.operation,
    compartment: e.compartment,
    namespace: e.namespace,
    region: e.region,
    started_at: new Date(e.startedAt).toISOString(),
    expires_at: new Date(e.expiresAt).toISOString(),
    outcome: "active",
  };
  for (const patch of [
    { operation: "different" },
    { compartment: "different" },
    { namespace: "different" },
    { region: "different" },
    { expires_at: new Date(e.expiresAt + 1).toISOString() },
    { started_at: new Date(e.startedAt + 1).toISOString() },
  ]) {
    let closed = false,
      opened = false;
    await assert.rejects(
      executeLive(e, "scheduled", "delivery", {
        database: () => ({
          connect: async () => {},
          end: async () => {
            closed = true;
          },
          query: async (sql: string) => {
            if (sql.includes("AS restricted"))
              return { rows: [{ restricted: true }] };
            if (sql.includes("berth_executor.open")) opened = true;
            return {
              rows: [
                { result: { trial: { ...trial, ...patch }, phase: "bucket" } },
              ],
            };
          },
        }),
      }),
    );
    assert.equal(opened, false);
    assert.equal(closed, true);
  }
  let closed = false;
  const result = await executeLive(e, "scheduled", "delivery", {
    database: () => ({
      connect: async () => {},
      end: async () => {
        closed = true;
      },
      query: async (sql: string) => {
        assert.equal(closed, false);
        if (sql.includes("AS restricted"))
          return { rows: [{ restricted: true }] };
        if (sql.includes("berth_executor.admission_status"))
          return { rows: [{ result: { admitted: true } }] };
        if (sql.includes("berth_executor.open")) {
          await new Promise((resolve) => setTimeout(resolve, 1));
          assert.equal(closed, false);
          return { rows: [{ result: { kind: "terminal" } }] };
        }
        return { rows: [{ result: { trial, phase: "bucket" } }] };
      },
    }),
  });
  assert.deepEqual(result, { phase: "terminal" });
  assert.equal(closed, true);
});

test("live execution refuses broad SQL privileges before reading the ledger", async () => {
  const { executeLive } = await import("../src/trial/live-runtime.js");
  let queries = 0,
    closed = false;
  await assert.rejects(
    executeLive(liveEnvironment(env), "evidence", undefined, {
      database: () => ({
        connect: async () => {},
        end: async () => {
          closed = true;
        },
        query: async () => {
          queries++;
          return { rows: [{ restricted: false }] };
        },
      }),
    }),
    /privilege/,
  );
  assert.equal(queries, 1);
  assert.equal(closed, true);
});

test("live transports sign the fixed OCI identity and enforce the creation deadline", async () => {
  const { liveTransports } = await import("../src/trial/live-runtime.js");
  const e = liveEnvironment(env);
  const requests: { url: string; authorization: string }[] = [];
  const transports = liveTransports(e, async (url, init) => {
    requests.push({
      url: String(url),
      authorization: new Headers(init?.headers).get("authorization") ?? "",
    });
    return new Response("[]", {
      headers: { "content-type": "application/json" },
    });
  });
  const sdk = transports.sdk(new AbortController().signal, now - 1);
  sdk.endpoint = `https://objectstorage.${e.region}.oraclecloud.com`;
  await assert.rejects(
    sdk.createBucket({
      namespaceName: e.namespace,
      createBucketDetails: { compartmentId: e.compartment, name: "fixture" },
    }),
  );
  assert.equal(requests.length, 0);
  await transports.usage(
    {
      namespace: "oci_objectstorage",
      query: "fixture",
      startTime: new Date(now - 3600000).toISOString(),
      endTime: new Date(now).toISOString(),
      resolution: "1h",
    },
    new AbortController().signal,
  );
  assert.equal(requests.length, 1);
  assert.ok(
    requests[0]?.url.startsWith(
      `https://telemetry.${e.region}.oraclecloud.com/`,
    ),
  );
  assert.ok(
    requests[0]?.authorization.includes(
      `${e.tenancy}/${e.user}/${e.fingerprint}`,
    ),
  );
});

test("live schedule forwards one gateway delivery without accepting manual bearer execution", async () => {
  const calls: string[] = [];
  const handler = makeLiveHandler(
    env,
    async (_e, action, delivery) => {
      calls.push(`${action}:${delivery}`);
      return { phase: "observe" };
    },
    () => now,
  );
  const body = JSON.stringify({
    version: 1,
    invocation_id: "fixture",
    trigger: { type: "schedule", id: "fixture-trigger" },
    data: { scheduled_at: new Date(now).toISOString() },
  });
  const rejected = await handler.fetch(
    new Request("https://fixture/scheduled", {
      method: "POST",
      body,
      headers: { authorization: `Bearer ${env.BERTH_TRIAL_TOKEN}` },
    }),
  );
  assert.equal(rejected.status, 401);
  const response = await handler.fetch(
    new Request("https://fixture/scheduled", {
      method: "POST",
      body,
      headers: { "x-neon-trigger-invocation-id": "fixture" },
    }),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(calls, [
    `scheduled:${createHash("sha256").update("fixture").digest("hex")}`,
  ]);
  const override = await handler.fetch(
    new Request("https://fixture/cleanup", {
      method: "POST",
      body: JSON.stringify({ operation: "another" }),
      headers: { authorization: `Bearer ${env.BERTH_TRIAL_TOKEN}` },
    }),
  );
  assert.equal(override.status, 400);
  assert.equal(calls.length, 1);
});

test("live build descriptor keeps the schedule disabled and the synthetic root separate", async () => {
  const { liveFunction, liveSchedule, executorFunction } = await import(
    "../neon.js"
  );
  assert.equal(liveFunction.source, "./src/trial/live-index.ts");
  assert.notEqual(liveFunction.source, executorFunction.source);
  assert.equal(liveSchedule.enabled, false);
  assert.equal(liveSchedule.function_slug, liveFunction.slug);
  assert.equal(liveSchedule.schedule.cron, "*/15 * * * *");
});

test("hosted preview reaches bounded API only after bearer authentication", async () => {
  let calls = 0;
  const handler = makeLiveHandler(
    env,
    async () => {
      throw Error("not executor work");
    },
    () => now,
    async (_e, request) => {
      calls++;
      assert.equal(new URL(request.url).pathname, "/preview");
      return Response.json({ preview: "fixture" });
    },
  );
  assert.equal(
    (
      await handler.fetch(
        new Request("https://fixture/preview", { method: "POST", body: "{}" }),
      )
    ).status,
    401,
  );
  assert.equal(calls, 0);
  assert.equal(
    (
      await handler.fetch(
        new Request("https://fixture/preview", {
          method: "POST",
          body: "{}",
          headers: { authorization: `Bearer ${env.BERTH_TRIAL_TOKEN}` },
        }),
      )
    ).status,
    200,
  );
  assert.equal(calls, 1);
});
