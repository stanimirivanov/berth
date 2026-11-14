import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "pg";
import { boundedObjectSdk } from "../src/providers/oci/client.js";
import { nextPhase, timing } from "../src/trial/executor.js";
import { syntheticSdk } from "../src/trial/executor-synthetic.js";

test("creation ends at minute thirty and cleanup starts no later than hour three", () => {
  assert.equal(nextPhase("bucket", 0, 0, false), "bucket");
  assert.equal(nextPhase("object", 0, 1799999, false), "object");
  assert.equal(nextPhase("object", 0, 1800000, false), "cleanup");
  assert.equal(nextPhase("observe", 0, 10800000, false), "cleanup");
  assert.equal(nextPhase("bucket", 0, 14400000, false), "expired");
  assert.equal(nextPhase("object", 0, 100, true), "cleanup");
  assert.ok(timing.cadenceMs > timing.invocationMs + timing.deliveryMarginMs);
  assert.equal((timing.expiryMs - timing.cleanupMs) / timing.cadenceMs, 4);
});

test("synthetic SDK never accepts a real cloud target", () => {
  assert.throws(
    () =>
      syntheticSdk(
        {
          operation: "fake",
          namespace: "real",
          compartment: "real",
          bucket: "real",
          marker: "fake",
          region: "eu-frankfurt-1",
        },
        async () => ({ bucket: false, object: false }),
      ),
    /synthetic/,
  );
});

test("signed transport aborts a stalled response stream at the per-request deadline", async () => {
  let seen: AbortSignal | undefined;
  const sdk = boundedObjectSdk(
    { signHttpRequest() {} },
    new AbortController().signal,
    async (_url, init) => {
      seen = init?.signal ?? undefined;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            seen?.addEventListener(
              "abort",
              () => controller.error(Error("aborted")),
              { once: true },
            );
          },
        }),
        { headers: { etag: "revision", "content-length": "1048576" } },
      );
    },
    20,
  );
  const keepAlive = setTimeout(() => {}, 1000);
  sdk.endpoint = "https://objectstorage.eu-frankfurt-1.oraclecloud.com";
  try {
    const result = await sdk.getObject({
      namespaceName: "fixture",
      bucketName: "fixture",
      objectName: "trial.bin",
    });
    const body = result.value;
    if (!("getReader" in body)) throw Error();
    await assert.rejects(body.getReader().read());
    assert.equal(seen?.aborted, true);
  } finally {
    clearTimeout(keepAlive);
    sdk.close();
  }
});

test("signing that crosses the creation cutoff cannot dispatch a write", async () => {
  let now = 100,
    sends = 0;
  const sdk = boundedObjectSdk(
    {
      async signHttpRequest() {
        now = 201;
      },
    },
    new AbortController().signal,
    async () => {
      sends++;
      return new Response(null);
    },
    5000,
    { creationDeadline: 200, now: () => now },
  );
  sdk.endpoint = "https://objectstorage.eu-frankfurt-1.oraclecloud.com";
  try {
    await assert.rejects(
      sdk.putObject({
        namespaceName: "fixture",
        bucketName: "fixture",
        objectName: "trial.bin",
        putObjectBody: new Uint8Array(1),
      }),
    );
    assert.equal(sends, 0);
  } finally {
    sdk.close();
  }
});

test("hosted proof rejects owner URLs and unexpected cloud credentials", async () => {
  const { executorEnvironment } = await import(
    "../src/trial/executor-hosted.js"
  );
  const env = {
    DATABASE_URL: "postgresql://berth_runtime:fixture@fixture.neon.tech/neondb",
    DATABASE_URL_UNPOOLED:
      "postgresql://berth_runtime:fixture@fixture.neon.tech/neondb",
    BERTH_EXECUTOR_STARTED_AT: "1000",
    BERTH_EXECUTOR_EXPIRES_AT: "14401000",
    BERTH_EXECUTOR_OPERATION: "00000000-0000-4000-8000-000000000000",
    BERTH_EXECUTOR_MODE: "synthetic",
    BERTH_TRIAL_TOKEN: "x".repeat(32),
  };
  assert.ok(executorEnvironment(env).connection.includes("verify-full"));
  assert.ok(
    executorEnvironment({
      ...env,
      PGPASSWORD: "disabled-for-berth-probe",
    }).connection.includes("verify-full"),
  );
  assert.ok(
    executorEnvironment({ ...env, PGPASSWORD: "fixture" }).connection.includes(
      "verify-full",
    ),
  );
  for (const name of ["DATABASE_URL", "DATABASE_URL_UNPOOLED"])
    assert.throws(() =>
      executorEnvironment({
        ...env,
        [name]: env.DATABASE_URL.replace("berth_runtime", "neondb_owner"),
      }),
    );
  for (const name of [
    "OCI_PRIVATE_KEY",
    "NEON_API_KEY",
    "AWS_SECRET_ACCESS_KEY",
  ])
    assert.throws(() => executorEnvironment({ ...env, [name]: "forbidden" }));
});

test("hosted configuration failures expose only a fixed diagnostic code", async () => {
  const { default: hosted } = await import("../src/trial/executor-hosted.js");
  const oldExpiry = process.env.BERTH_EXECUTOR_EXPIRES_AT;
  const oldKey = process.env.OCI_PRIVATE_KEY;
  try {
    process.env.BERTH_EXECUTOR_EXPIRES_AT = String(Date.now() + 60000);
    process.env.OCI_PRIVATE_KEY = "never-disclose-this-value";
    const response = await hosted.fetch(
      new Request("https://fixture.invalid/evidence", { method: "POST" }),
    );
    assert.deepEqual(await response.json(), {
      error: "executor-unavailable",
      reason: "Unexpected OCI credentials",
    });
  } finally {
    if (oldExpiry === undefined) delete process.env.BERTH_EXECUTOR_EXPIRES_AT;
    else process.env.BERTH_EXECUTOR_EXPIRES_AT = oldExpiry;
    if (oldKey === undefined) delete process.env.OCI_PRIVATE_KEY;
    else process.env.OCI_PRIVATE_KEY = oldKey;
  }
});

test("expired hosted root returns before parsing credentials or connecting", async () => {
  const { default: hosted } = await import("../src/trial/executor-hosted.js");
  const old = process.env.BERTH_EXECUTOR_EXPIRES_AT;
  try {
    process.env.BERTH_EXECUTOR_EXPIRES_AT = "0";
    const response = await hosted.fetch(
      new Request("https://fixture.invalid/scheduled", { method: "POST" }),
    );
    assert.deepEqual(await response.json(), { phase: "expired" });
  } finally {
    if (old === undefined) delete process.env.BERTH_EXECUTOR_EXPIRES_AT;
    else process.env.BERTH_EXECUTOR_EXPIRES_AT = old;
  }
});

test("hosted connection remains open until scheduled execution settles", async (t) => {
  const { execute } = await import("../src/trial/executor-hosted.js");
  let closed = false;
  t.mock.method(Client.prototype, "connect", async () => {});
  t.mock.method(Client.prototype, "end", async () => {
    closed = true;
  });
  t.mock.method(Client.prototype, "query", async (sql: string) => {
    if (sql.includes("current_user")) return { rows: [{ restricted: true }] };
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(closed, false, "connection closed before claim response");
    return { rows: [{ result: { kind: "terminal" } }] };
  });
  const result = await execute(
    {
      connection: "postgresql://fixture.invalid/neondb",
      startedAt: Date.now(),
      expiresAt: Date.now() + 60000,
      operation: "fixture",
      token: "fixture",
    },
    "a".repeat(64),
  );
  assert.deepEqual(result, { phase: "terminal" });
  assert.equal(closed, true);
});

test("shared hosted deadline refuses another executor step before opening SQL", async () => {
  const { runExecutor } = await import("../src/trial/executor.js");
  let calls = 0;
  const result = await runExecutor(
    {
      query: async () => {
        calls++;
        throw Error("must not connect");
      },
    },
    {
      operation: "fixture",
      delivery: "fixture",
      expiresAt: Date.now() + 10000,
      deadlineAt: Date.now() - 1,
      sdk: () => {
        throw Error("must not dispatch");
      },
    },
  );
  assert.deepEqual(result, { phase: "expired" });
  assert.equal(calls, 0);
});
