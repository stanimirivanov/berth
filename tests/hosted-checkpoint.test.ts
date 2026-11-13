import assert from "node:assert/strict";
import test from "node:test";
import { makeCheckpointHandler } from "../src/trial/checkpoint-handler.js";

const token = "x".repeat(32);
function scheduled(id = "delivery-1") {
  return new Request("https://test/scheduled", {
    method: "POST",
    headers: { "x-neon-trigger-invocation-id": id },
    body: JSON.stringify({
      version: 1,
      invocation_id: id,
      trigger: { type: "schedule", id: "trigger-1" },
      data: { scheduled_at: new Date().toISOString() },
    }),
  });
}
test("checkpoint admits only bounded attested schedules and authenticated evidence", async () => {
  let work = 0;
  let reads = 0;
  const handler = makeCheckpointHandler({
    token,
    expiresAt: Date.now() + 60000,
    run: async () => {
      work++;
      return { done: true };
    },
    evidence: async () => {
      reads++;
      return {};
    },
  });
  assert.equal(
    (
      await handler.fetch(
        new Request("https://test/evidence", { method: "POST" }),
      )
    ).status,
    401,
  );
  assert.equal(
    (
      await handler.fetch(
        new Request("https://test/scheduled", { method: "POST", body: "{}" }),
      )
    ).status,
    401,
  );
  assert.equal(work, 0);
  assert.equal(reads, 0);
  assert.equal((await handler.fetch(scheduled())).status, 200);
  assert.equal(work, 1);
  assert.equal(
    (
      await handler.fetch(
        new Request("https://test/evidence", {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
        }),
      )
    ).status,
    200,
  );
  assert.equal(reads, 1);
});
test("expired checkpoints do not connect to the database and failures disclose no provider data", async () => {
  let work = 0;
  const options = {
    token,
    expiresAt: Date.now() - 1,
    run: async () => {
      work++;
      throw Error("private-canary");
    },
    evidence: async () => {
      work++;
      throw Error("private-canary");
    },
  };
  assert.equal(
    (await makeCheckpointHandler(options).fetch(scheduled())).status,
    200,
  );
  assert.equal(work, 0);
  const response = await makeCheckpointHandler({
    ...options,
    expiresAt: Date.now() + 60000,
  }).fetch(scheduled());
  assert.equal(response.status, 503);
  assert.ok(!(await response.text()).includes("canary"));
});
test("checkpoint rejects oversized envelopes, queries and unknown routes without work", async () => {
  let work = 0;
  const handler = makeCheckpointHandler({
    token,
    expiresAt: Date.now() + 60000,
    run: async () => {
      work++;
    },
    evidence: async () => {
      work++;
    },
  });
  assert.equal(
    (
      await handler.fetch(
        new Request("https://test/scheduled", {
          method: "POST",
          headers: { "x-neon-trigger-invocation-id": "a" },
          body: "x".repeat(4097),
        }),
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await handler.fetch(
        new Request("https://test/scheduled?x=1", { method: "POST" }),
      )
    ).status,
    404,
  );
  assert.equal(work, 0);
});

test("hosted credential boundary rejects either owner URL and unexpected service credentials", async () => {
  const { checkpointDatabaseUrl } = await import(
    "../src/trial/checkpoint-index.js"
  );
  const runtime =
    "postgresql://berth_runtime:fixture@ep-fixture.us-east-2.aws.neon.tech/neondb?sslmode=require";
  const env = { DATABASE_URL: runtime, DATABASE_URL_UNPOOLED: runtime };
  assert.match(checkpointDatabaseUrl(env, "24.22.1"), /sslmode=verify-full/);
  for (const name of ["DATABASE_URL", "DATABASE_URL_UNPOOLED"])
    assert.throws(() =>
      checkpointDatabaseUrl(
        { ...env, [name]: runtime.replace("berth_runtime", "neondb_owner") },
        "24.22.1",
      ),
    );
  assert.throws(() =>
    checkpointDatabaseUrl({ ...env, NEON_API_KEY: "canary" }, "24.22.1"),
  );
  assert.throws(() =>
    checkpointDatabaseUrl(
      { ...env, AWS_SECRET_ACCESS_KEY: "canary" },
      "24.22.1",
    ),
  );
  assert.throws(() => checkpointDatabaseUrl(env, "22.0.0"));
});
