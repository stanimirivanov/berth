import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Client } from "pg";
import { retainedInventoryLedger } from "../../src/application/retained-trial-ledger/inventory.ts";

const observed = "2026-01-01T10:00:00+00:00";
const unresolved = "2026-01-01T10:05:00+00:00";
const removed = "2026-01-01T10:10:00+00:00";
const firstId = "10000000-0000-4000-8000-000000000001";
const secondId = "10000000-0000-4000-8000-000000000002";
const bucketA = "ocid1.bucket.oc1..fixtureA";
const bucketB = "ocid1.bucket.oc1..fixtureB";

/** Create a retained operation with no implied OCI observations. */
async function operation(owner: Client) {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO berth_ledger.trials(
      operation, compartment, region, namespace, digest, bucket, expires_at,
      outcome, monitoring_limit, neon_limit
    ) VALUES(
      $1, 'private-compartment', 'eu-frankfurt-1', 'private-namespace',
      repeat('a',64), 'fixture-bucket', '2026-01-01T09:00:00Z', 'failed', 20, 40
    )`,
    [id],
  );
  return id;
}

/** Read the public inventory projection with a bounded keyset page. */
async function page(client: Client, after: string | null = null, limit = 20) {
  return retainedInventoryLedger(client).page(after, limit);
}

test("retained inventory projects identity-bound presence and coverage through a restricted reader", async () => {
  const port = Number(process.env.BERTH_TEST_POSTGRES_PORT);
  assert.ok(
    Number.isInteger(port) && port > 0 && port < 65536,
    "Set BERTH_TEST_POSTGRES_PORT for the disposable local database",
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
  const reader = new Client({ ...config, user: "berth_inventory_fixture" });

  let ledgerInstalled = false;
  let inventoryInstalled = false;
  let fixtureRoleCreated = false;
  try {
    await admin.connect();
    await owner.connect();
    try {
      await owner.query(await readFile("migrations/001_trial.sql", "utf8"));
      ledgerInstalled = true;
      await owner.query(
        await readFile("migrations/009_managed_inventory.sql", "utf8"),
      );
      inventoryInstalled = true;
    } catch (error) {
      await owner.query("ROLLBACK");
      throw error;
    }
    assert.deepEqual(await page(owner), {
      offering: "oci-object-storage-bucket",
      coverage: "incomplete",
      items: [],
      next: null,
    });

    await admin.query(
      "CREATE ROLE berth_inventory_fixture LOGIN PASSWORD 'berth-test-only'",
    );
    fixtureRoleCreated = true;
    await admin.query(
      "GRANT berth_inventory_reader TO berth_inventory_fixture",
    );
    await reader.connect();
    for (const limit of [0, 51]) {
      await assert.rejects(page(reader, null, limit), {
        message: "Invalid inventory limit",
      });
    }
    for (const query of [
      "SELECT provider_id FROM berth_inventory.instances",
      "SELECT source FROM berth_inventory.observations",
      "SELECT * FROM berth_ledger.trials",
      "DELETE FROM berth_inventory.observations",
    ]) {
      await assert.rejects(reader.query(query), { code: "42501" });
    }
    const runtimeAccess = await admin.query(
      "SELECT has_function_privilege('berth_runtime', 'berth_inventory.inventory_page(uuid,integer)', 'EXECUTE') AS allowed",
    );
    assert.equal(runtimeAccess.rows[0]?.allowed, false);

    const first = await operation(owner);
    const second = await operation(owner);
    const unmatched = await operation(owner);
    await owner.query(
      "INSERT INTO berth_inventory.scope_review(reviewed_at) VALUES($1)",
      [observed],
    );
    await owner.query(
      `INSERT INTO berth_inventory.instances(id, provider_id, operation, region, display_name)
       VALUES ($1,$2,$3,'eu-frankfurt-1','fixture-bucket'), ($4,$5,$6,'eu-frankfurt-1','fixture-bucket')`,
      [firstId, bucketA, first, secondId, bucketB, second],
    );
    await owner.query(
      `INSERT INTO berth_inventory.observations(provider_id, observed_at, kind, source)
       VALUES ($1,$3,'present','executor'), ($2,$3,'create-unresolved','executor')`,
      [bucketA, bucketB, observed],
    );

    for (const [provider, retainedOperation] of [
      [bucketA, unmatched],
      ["ocid1.bucket.oc1..conflict", first],
    ]) {
      await assert.rejects(
        owner.query(
          `INSERT INTO berth_inventory.instances(provider_id, operation, region, display_name)
           VALUES($1,$2,'eu-frankfurt-1','fixture-bucket')`,
          [provider, retainedOperation],
        ),
        { code: "23505" },
      );
    }
    await assert.rejects(
      owner.query(
        `INSERT INTO berth_inventory.observations(provider_id, observed_at, kind, source)
         VALUES('ocid1.bucket.oc1..unbound',$1,'removed','owner')`,
        [removed],
      ),
      { code: "23503" },
    );

    const firstPage = await page(reader, null, 1);
    assert.deepEqual(firstPage, {
      offering: "oci-object-storage-bucket",
      coverage: "incomplete",
      items: [
        {
          instance: firstId,
          displayName: "fixture-bucket",
          region: "eu-frankfurt-1",
          presence: "verified-present",
          observedAt: observed,
          lastVerifiedAt: observed,
          uncertainty: null,
          operation: first,
        },
      ],
      next: firstId,
    });
    const secondPage = await page(reader, firstPage.next, 1);
    assert.deepEqual(secondPage.items, [
      {
        instance: secondId,
        displayName: "fixture-bucket",
        region: "eu-frankfurt-1",
        presence: "uncertain",
        observedAt: observed,
        lastVerifiedAt: null,
        uncertainty: "create-unresolved",
        operation: second,
      },
    ]);
    assert.equal(secondPage.next, null);

    await owner.query(
      `INSERT INTO berth_inventory.observations(provider_id, observed_at, kind, source)
       VALUES ($1,$2,'delete-unresolved','executor')`,
      [bucketA, unresolved],
    );
    assert.deepEqual((await page(reader)).items[0], {
      ...firstPage.items[0],
      presence: "uncertain",
      observedAt: unresolved,
      uncertainty: "delete-unresolved",
    });
    await owner.query(
      `INSERT INTO berth_inventory.observations(provider_id, observed_at, kind, source)
       VALUES ($1,$2,'removed','owner')`,
      [bucketA, removed],
    );
    assert.deepEqual((await page(reader, firstId, 1)).items, secondPage.items);
    await assert.rejects(
      owner.query(
        `INSERT INTO berth_inventory.observations(provider_id, observed_at, kind, source)
         VALUES ($1,$2,'present','executor')`,
        [bucketA, removed],
      ),
      { code: "23505" },
    );
    await owner.query(
      `INSERT INTO berth_inventory.observations(provider_id, observed_at, kind, source)
       VALUES ($1,'2026-01-01T10:09:00Z','present','owner'), ($2,$3,'removed','owner')`,
      [bucketA, bucketB, removed],
    );
    assert.deepEqual(await page(reader), {
      offering: "oci-object-storage-bucket",
      coverage: "incomplete",
      items: [],
      next: null,
    });
    await owner.query(
      "INSERT INTO berth_inventory.operation_coverage(operation, disposition, observed_at) VALUES($1,'no-instance',$2)",
      [unmatched, removed],
    );
    await owner.query(
      "INSERT INTO berth_inventory.operation_coverage(operation, disposition, observed_at) VALUES($1,'gap',$2)",
      [first, removed],
    );
    assert.equal((await page(reader)).coverage, "incomplete");
    await owner.query(
      "DELETE FROM berth_inventory.operation_coverage WHERE operation = $1",
      [first],
    );
    assert.deepEqual(await page(reader), {
      offering: "oci-object-storage-bucket",
      coverage: "complete",
      items: [],
      next: null,
    });
  } finally {
    await reader.end();
    try {
      if (inventoryInstalled)
        await owner.query("DROP SCHEMA berth_inventory CASCADE");
      if (ledgerInstalled)
        await owner.query("DROP SCHEMA berth_ledger CASCADE");
      if (fixtureRoleCreated)
        await admin.query("DROP ROLE berth_inventory_fixture");
      if (inventoryInstalled)
        await admin.query("DROP ROLE berth_inventory_reader");
    } finally {
      await Promise.all([owner.end(), admin.end()]);
    }
  }
});
