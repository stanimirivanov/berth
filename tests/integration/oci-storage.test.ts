import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Client } from "pg";
import { ociStorageApi } from "../../src/application/oci-storage/api.ts";
import { storageRepository } from "../../src/storage/postgres/oci-storage.ts";
import { onRequest } from "../../ui/functions/api/inventory/oci-storage.ts";

const tenancy = "ocid1.tenancy.oc1..allowancesfixture";
const legacySettled = "ocid1.tenancy.oc1..legacysettled";
const legacyPending = "ocid1.tenancy.oc1..legacypending";
const legacySlot = "2026-11-28T10:00:00.000Z";

test("one hourly claim survives duplicate delivery and a failed refresh preserves the prior reading", async () => {
  const port = Number(process.env.BERTH_TEST_POSTGRES_PORT);
  assert.ok(
    Number.isInteger(port) && port > 0 && port < 65536,
    "Set BERTH_TEST_POSTGRES_PORT to a fresh loopback database",
  );
  const config = {
    host: "127.0.0.1",
    port,
    database: "neondb",
    password: "berth-test-only",
    connectionTimeoutMillis: 5000,
    statement_timeout: 5000,
  };
  const admin = new Client({ ...config, user: "postgres" });
  const owner = new Client({ ...config, user: "neondb_owner" });
  const runtime = { ...config, user: "berth_oci_storage_runtime" };
  const restricted = new Client(runtime);
  try {
    await admin.connect();
    const existing = await admin.query(
      "SELECT 1 FROM pg_roles WHERE rolname = 'neondb_owner'",
    );
    if (!existing.rowCount) {
      await admin.query(
        "CREATE ROLE neondb_owner LOGIN NOINHERIT PASSWORD 'berth-test-only'",
      );
      await admin.query("GRANT CREATE ON DATABASE neondb TO neondb_owner");
    }
    await admin.query(
      "CREATE ROLE berth_oci_storage_runtime LOGIN NOINHERIT PASSWORD 'berth-test-only'",
    );
    await owner.connect();
    await owner.query(await readFile("migrations/014_oci_storage.sql", "utf8"));
    await owner.query(
      "INSERT INTO berth_oci_allowances.storage (tenancy, attempted_at, settled, gap) VALUES" +
        " ($1, $3, true, 'response-time-unverified'), ($2, $3, false, 'oci-unavailable')",
      [legacySettled, legacyPending, legacySlot],
    );
    await owner.query(
      await readFile("migrations/015_oci_storage_provenance.sql", "utf8"),
    );
    await restricted.connect();
    await assert.rejects(
      restricted.query("SELECT * FROM berth_oci_allowances.storage"),
      { code: "42501" },
    );
    await assert.rejects(
      restricted.query("DELETE FROM berth_oci_allowances.storage"),
      { code: "42501" },
    );
    const makeRepository = (target: string) =>
      storageRepository(
        target,
        {
          BERTH_OCI_STORAGE_DATABASE_URL:
            "postgresql://berth_oci_storage_runtime:fixture@ep-fixture.aws.neon.tech/neondb",
        },
        () => new Client(runtime),
      );
    const repository = makeRepository(tenancy);
    assert.deepEqual(await makeRepository(legacySettled).read(), {
      attemptedAt: legacySlot,
      gap: "response-time-unverified",
      reading: null,
      provenance: { lastSettledAttemptAt: legacySlot, pending: null },
    });
    assert.deepEqual(await makeRepository(legacyPending).read(), {
      attemptedAt: legacySlot,
      gap: "oci-unavailable",
      reading: null,
      provenance: {
        lastSettledAttemptAt: null,
        pending: { startedAt: null, overdueAt: null },
      },
    });
    assert.deepEqual(await repository.read(), {
      attemptedAt: null,
      gap: null,
      reading: null,
    });

    await owner.query(
      "GRANT SELECT ON berth_oci_allowances.storage TO berth_oci_storage_runtime",
    );
    await assert.rejects(repository.read(), /privilege boundary failed/);
    await owner.query(
      "REVOKE SELECT ON berth_oci_allowances.storage FROM berth_oci_storage_runtime",
    );

    const first = new Date().toISOString();
    assert.deepEqual(
      (
        await Promise.all([repository.claim(first), repository.claim(first)])
      ).sort(),
      [false, true],
    );
    const reading = {
      usedBytes: 46_377,
      limitBytes: 20_000_000_000,
      source: "OCI",
      respondedAt: first,
      accountingCutoff: first,
      observedAt: first,
      expiresAt: new Date(Date.parse(first) + 2 * 3_600_000).toISOString(),
    } as const;
    await repository.finish(first, { gap: null, reading });
    assert.deepEqual(await repository.read(), {
      attemptedAt: first,
      gap: null,
      reading,
      provenance: { lastSettledAttemptAt: first, pending: null },
    });
    await repository.finish(first, {
      gap: "storage-coverage-unverified",
      reading: null,
    });
    assert.deepEqual(await repository.read(), {
      attemptedAt: first,
      gap: null,
      reading,
      provenance: { lastSettledAttemptAt: first, pending: null },
    });

    const browserToken = "b".repeat(40);
    const upstreamToken = "s".repeat(40);
    const origin = "https://berth.example";
    const pendingApi = ociStorageApi(
      upstreamToken,
      repository,
      async () => {
        throw Error("A saved read cannot collect");
      },
      "fixture-allowance-trigger",
    );
    const readSaved = () =>
      onRequest(
        {
          request: new Request(`${origin}/api/inventory/oci-storage`, {
            headers: { authorization: `Bearer ${browserToken}` },
          }),
          env: {
            BERTH_HISTORY_SITE_ORIGIN: origin,
            BERTH_HISTORY_ACCESS_TOKEN: browserToken,
            BERTH_OCI_STORAGE_UPSTREAM_TOKEN: upstreamToken,
            BERTH_OCI_STORAGE_NEON_ORIGIN:
              "https://berthocistorage200.compute.aws.neon.tech",
          },
        },
        (input, options) => pendingApi.fetch(new Request(input, options)),
      );

    // Simulate the next hourly slot without changing the database wall clock.
    await owner.query(
      "UPDATE berth_oci_allowances.storage SET attempted_at = attempted_at - interval '1 hour' WHERE tenancy = $1",
      [tenancy],
    );
    const next = new Date().toISOString();
    assert.equal(await repository.claim(next), true);
    await repository.finish(first, { gap: "oci-unavailable", reading: null });
    const pendingResponse = await readSaved();
    assert.equal(pendingResponse.status, 200);
    const pending = await pendingResponse.json();
    assert.equal(pending.attemptedAt, next);
    assert.equal(pending.gap, null);
    assert.deepEqual(pending.reading, reading);
    assert.equal(pending.provenance?.lastSettledAttemptAt, first);
    const started = Date.parse(pending.provenance.pending.startedAt);
    const deadline = Date.parse(pending.provenance.pending.overdueAt);
    assert.ok(started >= Date.parse(next) && started <= Date.now());
    assert.equal(deadline - started, 10_000);
    await assert.rejects(
      repository.finish(next, {
        gap: null,
        reading: { ...reading, expiresAt: "2099-01-01T00:00:00.000Z" },
      }),
      /Invalid OCI storage reading/,
    );
    assert.deepEqual(await (await readSaved()).json(), pending);
    await repository.finish(next, { gap: "oci-unavailable", reading: null });
    assert.deepEqual(await repository.read(), {
      attemptedAt: next,
      gap: "oci-unavailable",
      reading,
      provenance: { lastSettledAttemptAt: next, pending: null },
    });
    // Reopen the same-origin view after a simulated native delivery has settled.
    await owner.query(
      "UPDATE berth_oci_allowances.storage SET attempted_at = attempted_at - interval '1 hour' WHERE tenancy = $1",
      [tenancy],
    );
    const delivery = new Date().toISOString();
    const api = ociStorageApi(
      upstreamToken,
      repository,
      async () => ({
        gap: null,
        reading: {
          ...reading,
          observedAt: delivery,
          respondedAt: delivery,
          accountingCutoff: delivery,
          expiresAt: new Date(Date.parse(delivery) + 7_200_000).toISOString(),
        },
      }),
      "fixture-allowance-trigger",
    );
    assert.equal(
      (
        await api.fetch(
          new Request("https://fixture.test/scheduled", {
            method: "POST",
            headers: { "x-neon-trigger-invocation-id": "fixture-delivery" },
            body: JSON.stringify({
              version: 1,
              invocation_id: "fixture-delivery",
              trigger: { type: "schedule", id: "fixture-allowance-trigger" },
              data: { scheduled_at: delivery },
            }),
          }),
        )
      ).status,
      200,
    );
    const response = await onRequest(
      {
        request: new Request(`${origin}/api/inventory/oci-storage`, {
          headers: { authorization: `Bearer ${browserToken}` },
        }),
        env: {
          BERTH_HISTORY_SITE_ORIGIN: origin,
          BERTH_HISTORY_ACCESS_TOKEN: browserToken,
          BERTH_OCI_STORAGE_UPSTREAM_TOKEN: upstreamToken,
          BERTH_OCI_STORAGE_NEON_ORIGIN:
            "https://berthocistorage200.compute.aws.neon.tech",
        },
      },
      (input, options) => api.fetch(new Request(input, options)),
    );
    assert.equal(response.status, 200);
    const snapshot = await response.json();
    assert.equal(snapshot.attemptedAt, delivery);
    assert.equal(snapshot.reading.usedBytes, 46_377);
    assert.equal(snapshot.reading.accountingCutoff, delivery);
    assert.deepEqual(snapshot.provenance, {
      lastSettledAttemptAt: delivery,
      pending: null,
    });
  } finally {
    await Promise.all([restricted.end(), owner.end(), admin.end()]);
  }
});
