import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Client } from "pg";
import { runCheckpoint } from "../../src/trial/checkpoint-run.js";

test("hosted checkpoint resumes durable state, deduplicates delivery and tears down once", async () => {
  const port = Number(process.env.BERTH_TEST_POSTGRES_PORT);
  assert.ok(port > 0 && port < 65536);
  const config = {
    host: "127.0.0.1",
    port,
    database: "neondb",
    connectionTimeoutMillis: 3000,
    statement_timeout: 5000,
  };
  const owner = new Client({
    ...config,
    user: "neondb_owner",
    password: "berth-test-only",
  });
  const db = new Client({
    ...config,
    user: "berth_runtime",
    password: "test-runtime-only",
  });
  let installed = false;
  try {
    await owner.connect();
    await db.connect();
    await owner.query(await readFile("sql/fenced-state.sql", "utf8"));
    installed = true;
    await owner.query(await readFile("sql/checkpoint.sql", "utf8"));
    const bootA = randomUUID(),
      bootB = randomUUID();
    assert.equal(
      (await runCheckpoint(db, "a".repeat(64), bootA)).phase,
      "first",
    );
    assert.equal(
      (await runCheckpoint(db, "a".repeat(64), bootB)).phase,
      "duplicate",
    );
    assert.equal(
      (await runCheckpoint(db, "b".repeat(64), bootB)).phase,
      "finish",
    );
    assert.equal(
      (await runCheckpoint(db, "c".repeat(64), randomUUID())).phase,
      "terminal",
    );
    const report = (
      await db.query("SELECT berth_state.probe_report() AS report")
    ).rows[0].report;
    assert.equal(report.events.length, 2);
    assert.equal(report.events[0].boot, bootA);
    assert.equal(report.events[1].boot, bootB);
    assert.equal(report.records, 0);
    assert.equal(report.terminal, true);
    await assert.rejects(
      db.query("DELETE FROM berth_state.probe_events"),
      /permission denied/,
    );
    // A recorded intent with no completion is never silently replayed after lease expiry.
    await owner.query(
      "UPDATE berth_state.probe_events SET done=false WHERE phase='finish'",
    );
    await assert.rejects(runCheckpoint(db, "d".repeat(64), randomUUID()));
  } finally {
    await db.end();
    if (installed) await owner.query("DROP SCHEMA berth_state CASCADE");
    await owner.end();
  }
});
