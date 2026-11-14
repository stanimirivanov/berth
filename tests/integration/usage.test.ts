import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Client } from "pg";
import { runExecutor } from "../../src/trial/executor.js";
import { executorApi } from "../../src/trial/executor-api.js";
import { executorStore } from "../../src/trial/executor-store.js";
import { makeLedger } from "../../src/trial/ledger.js";
import { usageStore } from "../../src/trial/warnings.js";
import { FakeObjects } from "../fakes/oci.js";

const digest =
  "fbbab289f7f94b25736c58be46a994c441fd02552cc6022352e3d86d2fab7c83";
async function fixture(work: (owner: Client, db: Client) => Promise<void>) {
  const port = Number(process.env.BERTH_TEST_POSTGRES_PORT);
  assert.ok(Number.isInteger(port) && port > 0 && port < 65536);
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
    }),
    db = new Client({
      ...config,
      user: "berth_runtime",
      password: "test-runtime-only",
    });
  let installed = false;
  try {
    await owner.connect();
    await db.connect();
    await owner.query(await readFile("migrations/001_trial.sql", "utf8"));
    installed = true;
    await owner.query(await readFile("migrations/002_executor.sql", "utf8"));
    await owner.query(await readFile("migrations/003_usage.sql", "utf8"));
    await work(owner, db);
  } finally {
    await db.end();
    if (installed) {
      await owner.query("DROP SCHEMA IF EXISTS berth_usage CASCADE");
      await owner.query("DROP SCHEMA IF EXISTS berth_executor CASCADE");
      await owner.query("DROP SCHEMA berth_ledger CASCADE");
    }
    await owner.end();
  }
}
async function start(db: Client, monitoringLimit = 20) {
  return makeLedger(db).start({
    operation: randomUUID(),
    compartment: "ocid1.compartment.oc1..fixture",
    region: "eu-frankfurt-1",
    namespace: "fixture",
    digest,
    monitoringLimit,
    neonLimit: 30,
  });
}
function delivery(n: number) {
  return createHash("sha256").update(String(n)).digest("hex");
}

test("hourly metered observations deduplicate warnings and survive teardown", () =>
  fixture(async (owner, db) => {
    const trial = await start(db),
      sdk = new FakeObjects();
    let calls = 0;
    const run = (n: number) =>
      runExecutor(db, {
        operation: trial.operation,
        delivery: delivery(n),
        expiresAt: Date.parse(trial.expires_at),
        sdk: () => sdk,
        usage: async (query) => {
          calls++;
          const metric = query.query.split("[")[0];
          return [
            {
              name: metric,
              namespace: "oci_objectstorage",
              compartmentId: trial.compartment,
              dimensions: {
                resourceID: sdk.value?.id,
                resourceDisplayName: trial.bucket,
                ...(metric === "AllRequests" ? {} : { tier: "Standard" }),
              },
              aggregatedDatapoints: [
                {
                  timestamp: new Date(Date.now() - 60000).toISOString(),
                  value: metric === "StoredBytes" ? 1048576 : 1,
                },
              ],
            },
          ];
        },
      });
    assert.deepEqual(await run(1), { phase: "object" });
    assert.deepEqual(await run(2), { phase: "observe" });
    await run(3);
    assert.equal(calls, 0);
    await owner.query(
      "UPDATE berth_usage.state SET uploaded_at=clock_timestamp()-interval '2 hours',next_due=clock_timestamp()-interval '1 second'",
    );
    await run(4);
    assert.equal(calls, 3);
    await run(5);
    assert.equal(calls, 3);
    await owner.query(
      "UPDATE berth_usage.state SET next_due=clock_timestamp()-interval '1 second'",
    );
    await run(6);
    assert.equal(calls, 6);
    assert.equal(
      (await owner.query("SELECT count(*)::int AS n FROM berth_usage.warnings"))
        .rows[0].n,
      1,
    );
    const report = (await usageStore(db).report(trial.operation)) as {
      evidence: string;
      warnings: unknown[];
    };
    assert.equal(report.evidence, "observed");
    assert.equal(report.warnings.length, 1);
    await executorStore(db).cleanup(trial.operation);
    assert.deepEqual(await run(7), { phase: "terminal" });
    assert.equal(calls, 6);
    const after = (await usageStore(db).report(trial.operation)) as {
      evidence: string;
      warnings: unknown[];
      closedAt: string;
    };
    assert.equal(after.warnings.length, 1);
    assert.equal(after.evidence, "observed");
    assert.ok(after.closedAt);
    const handler = executorApi(db, {
      token: "a".repeat(40),
      previewKey: "b".repeat(40),
      configuration: {
        compartment: trial.compartment,
        namespace: trial.namespace,
        region: trial.region,
        monitoringLimit: 20,
        neonLimit: 30,
      },
      headroom: async () => {
        throw Error();
      },
      verifyCredentials: async () => {
        throw Error();
      },
    });
    const response = await handler.fetch(
      new Request("https://fixture.invalid/usage", {
        method: "POST",
        headers: {
          authorization: `Bearer ${"a".repeat(40)}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ operation: trial.operation }),
      }),
    );
    assert.equal(response.status, 200);
    assert.equal((await response.json()).warnings.length, 1);
    assert.equal(sdk.value, undefined);
    await assert.rejects(db.query("DELETE FROM berth_usage.warnings"));
  }));

test("Monitoring budget exhaustion leaves unknown evidence and never delays cleanup", () =>
  fixture(async (owner, db) => {
    const trial = await start(db, 2),
      sdk = new FakeObjects();
    let calls = 0;
    const run = (n: number) =>
      runExecutor(db, {
        operation: trial.operation,
        delivery: delivery(n),
        expiresAt: Date.parse(trial.expires_at),
        sdk: () => sdk,
        usage: async () => {
          calls++;
          return [];
        },
      });
    await run(1);
    await run(2);
    await owner.query(
      "UPDATE berth_usage.state SET uploaded_at=clock_timestamp()-interval '2 hours',next_due=clock_timestamp()-interval '1 second'",
    );
    await run(3);
    assert.equal(calls, 2);
    assert.equal(
      (await owner.query("SELECT monitoring_used FROM berth_ledger.trials"))
        .rows[0].monitoring_used,
      2,
    );
    await executorStore(db).cleanup(trial.operation);
    assert.deepEqual(await run(4), { phase: "terminal" });
    assert.equal(calls, 2);
    assert.equal(
      ((await usageStore(db).report(trial.operation)) as { evidence: string })
        .evidence,
      "inconclusive",
    );
  }));

test("cleanup admitted during collection prevents subsequent Monitoring dispatch", () =>
  fixture(async (owner, db) => {
    const trial = await start(db),
      sdk = new FakeObjects();
    let calls = 0;
    const run = (n: number) =>
      runExecutor(db, {
        operation: trial.operation,
        delivery: delivery(n),
        expiresAt: Date.parse(trial.expires_at),
        sdk: () => sdk,
        usage: async () => {
          calls++;
          await executorStore(db).cleanup(trial.operation);
          return [];
        },
      });
    await run(1);
    await run(2);
    await owner.query(
      "UPDATE berth_usage.state SET uploaded_at=clock_timestamp()-interval '2 hours',next_due=clock_timestamp()-interval '1 second'",
    );
    await run(3);
    assert.equal(calls, 1);
    assert.deepEqual(await run(4), { phase: "terminal" });
    assert.equal(calls, 1);
  }));

test("recording a poll is immutable and stale claims cannot manufacture warning history", () =>
  fixture(async (owner, db) => {
    const trial = await start(db),
      sdk = new FakeObjects();
    const run = (n: number) =>
      runExecutor(db, {
        operation: trial.operation,
        delivery: delivery(n),
        expiresAt: Date.parse(trial.expires_at),
        sdk: () => sdk,
        usage: async () => [],
      });
    await run(1);
    await run(2);
    await owner.query(
      "UPDATE berth_usage.state SET uploaded_at=clock_timestamp()-interval '2 hours',next_due=clock_timestamp()-interval '1 second'",
    );
    await run(3);
    const samples = (
      await owner.query("SELECT samples FROM berth_usage.observations")
    ).rows[0].samples;
    const ledger = makeLedger(db),
      claim = await ledger.claim(trial.operation, randomUUID());
    await usageStore(db).record(claim, samples);
    const forged = structuredClone(samples);
    forged[0] = {
      ...forged[0],
      status: "known",
      value: 1048576,
      sourceAt: new Date(Date.now() - 60000).toISOString(),
    };
    await assert.rejects(usageStore(db).record(claim, forged));
    assert.equal(
      (await owner.query("SELECT count(*)::int AS n FROM berth_usage.warnings"))
        .rows[0].n,
      0,
    );
    await ledger.release(claim);
    const next = await ledger.claim(trial.operation, randomUUID());
    await assert.rejects(usageStore(db).record(claim, samples));
    await ledger.release(next);
  }));

test("hour-three cutoff crossed during SQL renewal prevents Monitoring dispatch", () =>
  fixture(async (owner, db) => {
    const trial = await start(db),
      sdk = new FakeObjects();
    let calls = 0,
      time = Date.now(),
      monitorGuard = false,
      monitorRenewals = 0;
    const wrapped = {
      async query(sql: string, values?: unknown[]) {
        const result = await db.query(sql, values);
        if (sql.includes("berth_usage.control") && values?.[3] === "allowed")
          monitorGuard = true;
        if (
          monitorGuard &&
          sql.includes("berth_ledger.control") &&
          values?.[3] === "renew" &&
          ++monitorRenewals === 2
        )
          time = Date.parse(trial.started_at) + 10800000;
        return result;
      },
    };
    const run = (n: number) =>
      runExecutor(wrapped, {
        operation: trial.operation,
        delivery: delivery(n),
        expiresAt: Date.parse(trial.expires_at),
        now: () => time,
        sdk: () => sdk,
        usage: async () => {
          calls++;
          return [];
        },
      });
    await run(1);
    await run(2);
    await owner.query(
      "UPDATE berth_usage.state SET uploaded_at=(SELECT started_at FROM berth_ledger.trials),next_due=clock_timestamp()-interval '1 second'",
    );
    time = Date.parse(trial.started_at) + 10800000 - 1000;
    await run(3);
    assert.equal(calls, 0);
    assert.deepEqual(await run(4), { phase: "terminal" });
    assert.equal(calls, 0);
  }));

test("hour-three cutoff crossed during final usage admission prevents Monitoring dispatch", () =>
  fixture(async (owner, db) => {
    const trial = await start(db),
      sdk = new FakeObjects();
    let calls = 0,
      time = Date.now(),
      admissionReads = 0;
    const wrapped = {
      async query(sql: string, values?: unknown[]) {
        const result = await db.query(sql, values);
        if (
          sql.includes("berth_usage.control") &&
          values?.[3] === "allowed" &&
          ++admissionReads === 5
        )
          time = Date.parse(trial.started_at) + 10800000;
        return result;
      },
    };
    const run = (n: number) =>
      runExecutor(wrapped, {
        operation: trial.operation,
        delivery: delivery(n),
        expiresAt: Date.parse(trial.expires_at),
        now: () => time,
        sdk: () => sdk,
        usage: async () => {
          calls++;
          return [];
        },
      });
    await run(1);
    await run(2);
    await owner.query(
      "UPDATE berth_usage.state SET uploaded_at=(SELECT started_at FROM berth_ledger.trials),next_due=clock_timestamp()-interval '1 second'",
    );
    time = Date.parse(trial.started_at) + 10800000 - 1000;
    await run(3);
    assert.equal(calls, 0);
    assert.deepEqual(await run(4), { phase: "terminal" });
    assert.equal(calls, 0);
  }));
