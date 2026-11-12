import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "pg";
import { prepareDatabase, verifyRuntime } from "../../scripts/neon-database.js";

// Explicit opt-in command, never connects to Neon or accepts a remote URL.
test("real PostgreSQL bootstrap, denial probes, repeat refusal and grant-drift detection", async () => {
  const port = Number(process.env.BERTH_TEST_POSTGRES_PORT);
  assert.ok(
    Number.isInteger(port) && port > 0 && port < 65536,
    "Set BERTH_TEST_POSTGRES_PORT for the disposable local database",
  );
  const config = {
    host: "127.0.0.1",
    port,
    database: "neondb",
    user: "postgres",
    password: "berth-test-only",
    connectionTimeoutMillis: 5000,
  };
  const admin = new Client(config);
  const owner = new Client({ ...config, user: "neondb_owner" });
  const runtime = new Client({
    ...config,
    user: "berth_runtime",
    password: "test-runtime-only",
  });
  const target = {
    database: "neondb",
    owner: "neondb_owner",
    role: "berth_runtime",
    schema: "berth_trial",
  };
  try {
    await admin.connect();
    await admin.query(
      "CREATE ROLE neondb_owner LOGIN CREATEROLE PASSWORD 'berth-test-only'",
    );
    await admin.query("ALTER DATABASE neondb OWNER TO neondb_owner");
    await owner.connect();
    await admin.query("CREATE SCHEMA shared_probe");
    await admin.query("GRANT CREATE ON SCHEMA shared_probe TO PUBLIC");
    await assert.rejects(
      prepareDatabase(owner, target, "test-runtime-only"),
      /boundary/,
    );
    const rolledBack = await admin.query(
      "SELECT EXISTS (SELECT FROM pg_roles WHERE rolname = 'berth_runtime') AS role_exists, EXISTS (SELECT FROM pg_namespace WHERE nspname = 'berth_trial') AS schema_exists",
    );
    assert.equal(rolledBack.rows[0]?.role_exists, false);
    assert.equal(rolledBack.rows[0]?.schema_exists, false);
    await admin.query("DROP SCHEMA shared_probe");
    await prepareDatabase(owner, target, "test-runtime-only");
    await runtime.connect();
    await verifyRuntime(runtime, target);
    const rows = await owner.query(
      "SELECT count(*)::integer AS count FROM berth_trial.permission_probe",
    );
    assert.equal(rows.rows[0]?.count, 0, "Verification leaves no data");
    await assert.rejects(
      prepareDatabase(owner, target, "replacement-password"),
      /not fresh/,
    );
    await verifyRuntime(runtime, target);
    await owner.query("GRANT CREATE ON SCHEMA berth_trial TO berth_runtime");
    await assert.rejects(verifyRuntime(runtime, target), /boundary/);
    await owner.query("REVOKE CREATE ON SCHEMA berth_trial FROM berth_runtime");
    await owner.query(
      "GRANT SELECT ON berth_trial.denied_probe TO berth_runtime",
    );
    await assert.rejects(verifyRuntime(runtime, target), /boundary/);
    await owner.query(
      "REVOKE SELECT ON berth_trial.denied_probe FROM berth_runtime",
    );
    await admin.query("GRANT pg_read_all_data TO berth_runtime");
    await assert.rejects(verifyRuntime(runtime, target), /boundary/);
    await admin.query("REVOKE pg_read_all_data FROM berth_runtime");
    await verifyRuntime(runtime, target);
  } finally {
    await runtime.end();
    await owner.end();
    await admin.end();
  }
});
