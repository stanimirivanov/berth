import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Client } from "pg";
import { assertExecutorPrivileges } from "../../src/trial/executor-hosted.js";

test("runtime startup rejects direct, column, inherited, schema and SET ROLE privilege drift before any write", async () => {
  const port = Number(process.env.BERTH_TEST_POSTGRES_PORT);
  assert.ok(Number.isInteger(port) && port > 0 && port < 65536);
  const config = { host: "127.0.0.1", port, database: "neondb" };
  const admin = new Client({
      ...config,
      user: "postgres",
      password: "berth-test-only",
    }),
    owner = new Client({
      ...config,
      user: "neondb_owner",
      password: "berth-test-only",
    }),
    runtime = new Client({
      ...config,
      user: "berth_runtime",
      password: "test-runtime-only",
    });
  await admin.connect();
  await owner.connect();
  await runtime.connect();
  try {
    for (const migration of ["001_trial", "002_executor", "003_usage"])
      await owner.query(await readFile(`migrations/${migration}.sql`, "utf8"));
    await assertExecutorPrivileges(runtime);
    await admin.query("CREATE ROLE berth_checkpoint_privileged NOLOGIN");
    await admin.query(
      "GRANT UPDATE ON berth_ledger.trials TO berth_checkpoint_privileged",
    );
    const variants = [
      [
        "GRANT UPDATE ON berth_ledger.trials TO berth_runtime",
        "REVOKE UPDATE ON berth_ledger.trials FROM berth_runtime",
      ],
      [
        "GRANT UPDATE(normal_used) ON berth_ledger.trials TO berth_runtime",
        "REVOKE UPDATE(normal_used) ON berth_ledger.trials FROM berth_runtime",
      ],
      [
        "GRANT CREATE ON SCHEMA berth_executor TO berth_runtime",
        "REVOKE CREATE ON SCHEMA berth_executor FROM berth_runtime",
      ],
      [
        "GRANT TEMP ON DATABASE neondb TO berth_runtime",
        "REVOKE TEMP ON DATABASE neondb FROM berth_runtime",
      ],
      [
        "GRANT berth_checkpoint_privileged TO berth_runtime WITH INHERIT FALSE, SET TRUE",
        "REVOKE berth_checkpoint_privileged FROM berth_runtime",
      ],
      [
        "GRANT berth_checkpoint_privileged TO berth_runtime WITH INHERIT TRUE, SET FALSE",
        "REVOKE berth_checkpoint_privileged FROM berth_runtime",
      ],
    ];
    for (const [grant, revoke] of variants) {
      assert.ok(grant && revoke);
      await admin.query(grant);
      try {
        await assert.rejects(
          () => assertExecutorPrivileges(runtime),
          /Runtime privilege boundary failed/,
        );
      } finally {
        await admin.query(revoke);
      }
      await assertExecutorPrivileges(runtime);
    }
    for (const table of [
      "berth_ledger.trials",
      "berth_ledger.requests",
      "berth_executor.work",
    ])
      assert.equal(
        (await owner.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]
          .n,
        0,
      );
  } finally {
    for (const schema of ["berth_usage", "berth_executor", "berth_ledger"])
      await owner.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.query("DROP ROLE IF EXISTS berth_checkpoint_privileged");
    await runtime.end();
    await owner.end();
    await admin.end();
  }
});
