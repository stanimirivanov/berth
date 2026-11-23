import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Client } from "pg";
import { runExecutor } from "../../src/trial/executor.ts";
import { executorApi } from "../../src/trial/executor-api.ts";
import { executorStore } from "../../src/trial/executor-store.ts";
import { syntheticSdk } from "../../src/trial/executor-synthetic.ts";
import { makeLedger } from "../../src/trial/ledger.ts";
import { FakeObjects } from "../fakes/oci.ts";

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
    await work(owner, db);
  } finally {
    await db.end();
    if (installed) {
      await owner.query("DROP SCHEMA IF EXISTS berth_executor CASCADE");
      await owner.query("DROP SCHEMA berth_ledger CASCADE");
    }
    await owner.end();
  }
}

async function start(db: Client) {
  return makeLedger(db).start({
    operation: randomUUID(),
    compartment: "ocid1.compartment.oc1..fixture",
    region: "eu-frankfurt-1",
    namespace: "fixture",
    digest,
    monitoringLimit: 20,
    neonLimit: 30,
  });
}

function delivery(n: number) {
  return createHash("sha256").update(String(n)).digest("hex");
}

test("scheduled phases use real Alchemy and SQL, deduplicate, teardown within reserve and stop terminal work", () =>
  fixture(async (owner, db) => {
    const trial = await start(db),
      sdk = new FakeObjects(),
      expiresAt = Date.parse(trial.expires_at);
    const run = (n: number) =>
      runExecutor(db, {
        operation: trial.operation,
        delivery: delivery(n),
        expiresAt,
        sdk: () => sdk,
      });
    assert.deepEqual(await run(1), { phase: "object" });
    assert.equal(sdk.creates, 1);
    assert.deepEqual(await run(1), { phase: "duplicate" });
    assert.deepEqual(await run(2), { phase: "cleanup" });
    assert.equal(sdk.puts, 1);
    assert.deepEqual(await run(3), { phase: "terminal" });
    assert.equal(sdk.object, undefined);
    assert.equal(sdk.value, undefined);
    const calls = sdk.calls.length;
    assert.deepEqual(await run(4), { phase: "terminal" });
    assert.equal(sdk.calls.length, calls);
    const row = (
      await owner.query(
        "SELECT cleanup_used,neon_used,outcome FROM berth_ledger.trials",
      )
    ).rows[0];
    assert.ok(row.cleanup_used <= 40);
    assert.equal(row.neon_used, 3);
    assert.equal(row.outcome, "succeeded");
  }));
test("lost create response remains unresolved until a late matching bucket is observed then cleaned", () =>
  fixture(async (owner, db) => {
    const trial = await start(db);
    class Lost extends FakeObjects {
      override async createBucket(
        r: Parameters<FakeObjects["createBucket"]>[0],
      ): Promise<never> {
        await super.createBucket(r);
        throw { statusCode: 500 };
      }
    }
    const sdk = new Lost(),
      run = (n: number) =>
        runExecutor(db, {
          operation: trial.operation,
          delivery: delivery(n),
          expiresAt: Date.parse(trial.expires_at),
          sdk: () => sdk,
        });
    assert.deepEqual(await run(1), { phase: "needs-reconciliation" });
    const late = sdk.value;
    sdk.value = undefined;
    assert.deepEqual(await run(2), { phase: "needs-reconciliation" });
    assert.equal(
      (
        await owner.query(
          "SELECT count(*)::int AS count FROM berth_ledger.requests WHERE mutation AND outcome='unresolved'",
        )
      ).rows[0].count,
      1,
    );
    sdk.value = late;
    assert.deepEqual(await run(3), { phase: "terminal" });
    assert.equal(sdk.creates, 1);
    assert.equal(sdk.value, undefined);
    assert.equal(
      (await executorStore(db).report(trial.operation)).trial.outcome,
      "failed",
    );
  }));

test("expiry crossed during the final SQL fence prevents the SDK callback", () =>
  fixture(async (_owner, db) => {
    const trial = await start(db),
      sdk = new FakeObjects();
    let now = Date.parse(trial.started_at),
      renewals = 0;
    const wrapped = {
      async query(text: string, values?: unknown[]) {
        const result = await db.query(text, values);
        if (values?.[3] === "renew" && ++renewals === 3)
          now = Date.parse(trial.expires_at);
        return result;
      },
    };
    await runExecutor(wrapped, {
      operation: trial.operation,
      delivery: delivery(1),
      expiresAt: Date.parse(trial.expires_at),
      now: () => now,
      sdk: () => sdk,
    });
    assert.equal(sdk.calls.length, 0);
  }));
test("overlapping claim and stale checkpoints cannot mutate provider identity", () =>
  fixture(async (_owner, db) => {
    const trial = await start(db),
      store = executorStore(db);
    const first = await store.open(trial.operation, randomUUID(), delivery(1));
    assert.equal(first.kind, "claimed");
    assert.equal(
      (await store.open(trial.operation, randomUUID(), delivery(2))).kind,
      "busy",
    );
    if (first.kind !== "claimed") throw Error();
    const ledger = makeLedger(db);
    const attempt = await ledger.begin(
      first.claim,
      randomUUID(),
      "create_bucket",
    );
    const request = randomUUID();
    await ledger.reserve(first.claim, attempt, request);
    await assert.rejects(
      ledger.settle(first.claim, request, "rejected", "read-only-interruption"),
    );
    await ledger.release(first.claim);
    const fresh = await store.open(trial.operation, randomUUID(), delivery(3));
    assert.equal(fresh.kind, "claimed");
    await assert.rejects(store.access(first.claim, "phase", "object"));
    await assert.rejects(
      ledger.settle(first.claim, request, "rejected", "not-dispatched"),
    );
    if (fresh.kind !== "claimed") throw Error();
    await assert.rejects(
      ledger.settle(fresh.claim, request, "rejected", "not-dispatched"),
    );
    await assert.rejects(
      ledger.settle(fresh.claim, request, "rejected", "read-only-interruption"),
    );
    const evidence = (await ledger.read(fresh.claim)) as {
      requests: { id: string; outcome: string }[];
    };
    assert.equal(
      evidence.requests.find((row) => row.id === request)?.outcome,
      "unresolved",
    );
  }));

test("SQL checkpoint vocabulary rejects null status and non-string revisions", () =>
  fixture(async (_owner, db) => {
    const trial = await start(db),
      store = executorStore(db),
      sdk = new FakeObjects();
    await runExecutor(db, {
      operation: trial.operation,
      delivery: delivery(1),
      expiresAt: Date.parse(trial.expires_at),
      sdk: () => sdk,
    });
    const opened = await store.open(trial.operation, randomUUID(), delivery(2));
    if (opened.kind !== "claimed") throw Error();
    const state = await store.access<Record<string, unknown>>(
      opened.claim,
      "get-state",
    );
    await assert.rejects(
      store.access(opened.claim, "set-state", { ...state, status: null }),
    );
    await assert.rejects(
      store.access(opened.claim, "bucket", {
        ...opened.snapshot.bucket,
        etag: 123,
      }),
    );
  }));

test("lost upload cleanup uses protected capacity even after normal allowance exhaustion", () =>
  fixture(async (owner, db) => {
    const trial = await start(db),
      sdk = new FakeObjects();
    const run = (n: number) =>
      runExecutor(db, {
        operation: trial.operation,
        delivery: delivery(n),
        expiresAt: Date.parse(trial.expires_at),
        sdk: () => sdk,
      });
    assert.deepEqual(await run(1), { phase: "object" });
    sdk.losePut = true;
    assert.deepEqual(await run(2), { phase: "needs-reconciliation" });
    await owner.query(
      "UPDATE berth_ledger.trials SET normal_used=160 WHERE operation=$1",
      [trial.operation],
    );
    assert.deepEqual(await run(3), { phase: "terminal" });
    assert.equal(sdk.puts, 1);
    assert.equal(sdk.value, undefined);
  }));
test("interrupted read-only reservation can be retired without clearing any mutation", () =>
  fixture(async (owner, db) => {
    const trial = await start(db),
      store = executorStore(db),
      ledger = makeLedger(db);
    const opening = await store.open(
      trial.operation,
      randomUUID(),
      delivery(1),
    );
    if (opening.kind !== "claimed") throw Error();
    const id = await ledger.begin(opening.claim, randomUUID(), "inspect");
    await ledger.reserve(opening.claim, id, randomUUID());
    await ledger.release(opening.claim);
    const sdk = new FakeObjects();
    const run = (n: number) =>
      runExecutor(db, {
        operation: trial.operation,
        delivery: delivery(n),
        expiresAt: Date.parse(trial.expires_at),
        sdk: () => sdk,
      });
    await run(2);
    await run(3);
    assert.deepEqual(await run(4), { phase: "terminal" });
    assert.equal(
      (
        await owner.query(
          "SELECT count(*)::int AS count FROM berth_ledger.requests WHERE basis='read-only-interruption'",
        )
      ).rows[0].count,
      1,
    );
  }));

test("API cleanup admission persists cancellation and executor performs only owned teardown", () =>
  fixture(async (_owner, db) => {
    const trial = await start(db),
      sdk = new FakeObjects();
    const run = (n: number) =>
      runExecutor(db, {
        operation: trial.operation,
        delivery: delivery(n),
        expiresAt: Date.parse(trial.expires_at),
        sdk: () => sdk,
      });
    await run(1);
    const api = executorApi(db, {
      token: "a".repeat(40),
      previewKey: "b".repeat(40),
      configuration: {
        compartment: trial.compartment,
        namespace: trial.namespace,
        region: trial.region,
        monitoringLimit: 20,
        neonLimit: 30,
      },
      headroom: async () => undefined,
      verifyCredentials: async () => false,
    });
    const result = await api.fetch(
      new Request("https://trial.invalid/cleanup", {
        method: "POST",
        headers: {
          authorization: `Bearer ${"a".repeat(40)}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ operation: trial.operation }),
      }),
    );
    assert.equal(result.status, 202);
    assert.deepEqual(await run(2), { phase: "terminal" });
    assert.equal(sdk.puts, 0);
    assert.equal(sdk.value, undefined);
  }));

test("hosted synthetic service shares real ledger and Alchemy while persisting no external resources", () =>
  fixture(async (owner, db) => {
    const trial = await makeLedger(db).start({
      operation: randomUUID(),
      compartment: "ocid1.compartment.oc1..synthetic",
      region: "eu-frankfurt-1",
      namespace: "berthsynthetic",
      digest,
      monitoringLimit: 20,
      neonLimit: 30,
    });
    const run = (n: number) =>
      runExecutor(db, {
        operation: trial.operation,
        delivery: delivery(n),
        expiresAt: Date.parse(trial.expires_at),
        sdk: (_signal, { claim, snapshot, store }) =>
          syntheticSdk(
            {
              operation: trial.operation,
              compartment: trial.compartment,
              region: trial.region,
              namespace: trial.namespace,
              bucket: snapshot.trial.bucket,
              marker: snapshot.trial.marker,
            },
            (value) => store.access(claim, "synthetic", value ?? null),
          ),
      });
    assert.deepEqual(await run(1), { phase: "object" });
    assert.deepEqual(await run(2), { phase: "cleanup" });
    assert.deepEqual(await run(3), { phase: "terminal" });
    const row = (
      await owner.query("SELECT state,synthetic FROM berth_executor.work")
    ).rows[0];
    assert.equal(row.state, null);
    assert.deepEqual(row.synthetic, { bucket: false, object: false });
  }));

test("interrupted cleanup GET resumes within protected reserve after normal budget exhaustion", () =>
  fixture(async (owner, db) => {
    const trial = await start(db);
    class Interrupted extends FakeObjects {
      interrupt = false;
      override async getObject(r: Parameters<FakeObjects["getObject"]>[0]) {
        const result = await super.getObject(r);
        if (this.interrupt) {
          this.interrupt = false;
          return {
            ...result,
            value: new ReadableStream<Uint8Array>({
              start(controller) {
                controller.error(Error("interrupted"));
              },
            }),
          };
        }
        return result;
      }
    }
    const sdk = new Interrupted();
    const run = (n: number) =>
      runExecutor(db, {
        operation: trial.operation,
        delivery: delivery(n),
        expiresAt: Date.parse(trial.expires_at),
        sdk: () => sdk,
      });
    assert.deepEqual(await run(1), { phase: "object" });
    assert.deepEqual(await run(2), { phase: "cleanup" });
    await owner.query(
      "UPDATE berth_ledger.trials SET normal_used=160 WHERE operation=$1",
      [trial.operation],
    );
    sdk.interrupt = true;
    assert.deepEqual(await run(3), { phase: "needs-reconciliation" });
    assert.deepEqual(await run(4), { phase: "terminal" });
    assert.equal(sdk.object, undefined);
    assert.equal(sdk.value, undefined);
    assert.equal(sdk.puts, 1);
    assert.equal(sdk.objectDeletes, 1);
    const row = (
      await owner.query(
        "SELECT normal_used,cleanup_used,outcome FROM berth_ledger.trials",
      )
    ).rows[0];
    assert.equal(row.normal_used, 160);
    assert.ok(row.cleanup_used <= 40);
    assert.equal(row.outcome, "failed");
  }));

test("lost object delete response is reconciled without repeating the mutation", () =>
  fixture(async (owner, db) => {
    const trial = await start(db);
    class LostDelete extends FakeObjects {
      override async deleteObject(
        r: Parameters<FakeObjects["deleteObject"]>[0],
      ): Promise<never> {
        await super.deleteObject(r);
        throw { statusCode: 500 };
      }
    }
    const sdk = new LostDelete();
    const run = (n: number) =>
      runExecutor(db, {
        operation: trial.operation,
        delivery: delivery(n),
        expiresAt: Date.parse(trial.expires_at),
        sdk: () => sdk,
      });
    await run(1);
    await run(2);
    assert.deepEqual(await run(3), { phase: "needs-reconciliation" });
    assert.equal(sdk.object, undefined);
    assert.equal(sdk.objectDeletes, 1);
    assert.equal(
      (
        await owner.query(
          "SELECT count(*)::int AS n FROM berth_ledger.requests WHERE mutation AND outcome='unresolved'",
        )
      ).rows[0].n,
      1,
    );
    assert.deepEqual(await run(4), { phase: "terminal" });
    assert.equal(sdk.objectDeletes, 1);
    assert.equal(sdk.value, undefined);
    const row = (
      await owner.query("SELECT cleanup_used,outcome FROM berth_ledger.trials")
    ).rows[0];
    assert.ok(row.cleanup_used <= 40);
    assert.equal(row.outcome, "failed");
    assert.equal(
      (
        await owner.query(
          "SELECT count(*)::int AS n FROM berth_ledger.requests WHERE outcome='unresolved'",
        )
      ).rows[0].n,
      0,
    );
    assert.equal(
      (
        await owner.query(
          "SELECT count(*)::int AS n FROM berth_ledger.requests WHERE mutation AND basis='reconciled-provider'",
        )
      ).rows[0].n,
      1,
    );
  }));

/** Install the inventory writers over a disposable fenced executor. */
function inventoryFixture(work: (owner: Client, db: Client) => Promise<void>) {
  return fixture(async (owner, db) => {
    await owner.query(
      await readFile("migrations/009_managed_inventory.sql", "utf8"),
    );
    try {
      await owner.query(
        await readFile("migrations/010_inventory_evidence.sql", "utf8"),
      );
      await work(owner, db);
    } finally {
      await owner.query("ROLLBACK");
      await owner.query("DROP SCHEMA berth_inventory CASCADE");
      await owner.query("DROP ROLE IF EXISTS berth_inventory_recorder");
      await owner.query("DROP ROLE berth_inventory_reader");
    }
  });
}

test("executor checkpoints publish identity-bound inventory without an extra provider call", () =>
  inventoryFixture(async (owner, db) => {
    const trial = await start(db);
    const sdk = new FakeObjects();
    const run = (n: number) =>
      runExecutor(db, {
        operation: trial.operation,
        delivery: delivery(n),
        expiresAt: Date.parse(trial.expires_at),
        sdk: () => sdk,
      });
    const readInventory = async () =>
      (await owner.query("SELECT berth_inventory.inventory_page() AS value"))
        .rows[0]?.value;
    assert.deepEqual(await run(810), { phase: "object" });
    const present = (await readInventory()).items[0];
    assert.equal(present?.operation, trial.operation);
    assert.equal(present?.presence, "verified-present");
    const source = await owner.query(
      `SELECT a.action, e.observed_at = r.resolved_at AS "timeMatches"
       FROM berth_inventory.executor_events e
       JOIN berth_ledger.requests r ON r.id::text || '/presence' = e.reference
       JOIN berth_ledger.attempts a ON a.id = r.attempt
       WHERE e.kind = 'present'`,
    );
    assert.deepEqual(source.rows, [
      { action: "create_bucket", timeMatches: true },
    ]);
    assert.equal(sdk.creates, 1);
    assert.deepEqual(await run(811), { phase: "cleanup" });
    assert.ok(sdk.value);
    sdk.value.etag = "fixture-newer-revision";
    assert.deepEqual(await run(812), { phase: "terminal" });
    assert.equal(sdk.lastIfMatch, "fixture-newer-revision");
    const removalProof = await owner.query(
      "SELECT proof->>'etag' AS revision, proof ? 'absenceRequest' AS checked FROM berth_inventory.executor_events WHERE kind='removed'",
    );
    assert.deepEqual(removalProof.rows, [
      { revision: "fixture-newer-revision", checked: true },
    ]);
    assert.deepEqual((await readInventory()).items, []);
    assert.equal(sdk.deletes, 1);
    assert.deepEqual(
      sdk.calls.map(({ method }) => method),
      [
        "list",
        "list",
        "create",
        "retention",
        "grants",
        "list",
        "get",
        "retention",
        "grants",
        "object-list",
        "versions",
        "uploads",
        "put",
        "head",
        "get-object",
        "object-list",
        "versions",
        "uploads",
        "get-object",
        "list",
        "get",
        "retention",
        "grants",
        "object-list",
        "versions",
        "uploads",
        "delete-object",
        "object-list",
        "versions",
        "uploads",
        "list",
        "get",
        "retention",
        "grants",
        "object-list",
        "uploads",
        "get",
        "delete",
        "list",
      ],
    );
    assert.deepEqual(
      (
        await owner.query(
          "SELECT kind FROM berth_inventory.executor_events ORDER BY observed_at",
        )
      ).rows,
      [{ kind: "present" }, { kind: "delete-prepared" }, { kind: "removed" }],
    );
  }));

test("the independent recorder qualifies exact historical evidence and preserves operation state", () =>
  inventoryFixture(async (owner, db) => {
    const trial = await start(db);
    await owner.query(
      `UPDATE berth_ledger.trials
       SET started_at = started_at - interval '1 day', expires_at = expires_at - interval '1 day',
           outcome = 'needs-reconciliation', cleanup_used = 14
       WHERE operation = $1`,
      [trial.operation],
    );
    const before = (
      await owner.query("SELECT berth_executor.report($1) AS value", [
        trial.operation,
      ])
    ).rows[0]?.value;
    const call = async (client: Client, receipt: unknown) =>
      (
        await client.query(
          "SELECT berth_inventory.submit_owner_receipt($1::jsonb) AS value",
          [JSON.stringify(receipt)],
        )
      ).rows[0]?.value;
    const readInventory = async () =>
      (await owner.query("SELECT berth_inventory.inventory_page() AS value"))
        .rows[0]?.value;
    const when = Date.parse(before.trial.started_at);
    const present = {
      reference: "fixture/presence",
      operation: trial.operation,
      observedAt: new Date(when + 1).toISOString(),
      kind: "present",
      bucket: {
        id: "ocid1.bucket.oc1..legacyFixture",
        region: trial.region,
        namespace: trial.namespace,
        compartment: trial.compartment,
        name: trial.bucket,
        operationTag: trial.operation,
        marker: before.trial.marker,
        etag: "fixture-revision",
      },
      observation: { status: 200, requestId: "fixture-get" },
    };
    // A known legacy delete reservation is newer than the owner presence receipt.
    const oldAttempt = randomUUID();
    await owner.query(
      "INSERT INTO berth_executor.work(operation,bucket) VALUES ($1,$2::jsonb)",
      [
        trial.operation,
        JSON.stringify({
          id: present.bucket.id,
          marker: present.bucket.marker,
          etag: present.bucket.etag,
          operation: trial.operation,
        }),
      ],
    );
    await owner.query(
      "INSERT INTO berth_ledger.attempts(id,operation,action,generation,ordinal) VALUES($1,$2,'delete_bucket',1,1)",
      [oldAttempt, trial.operation],
    );
    await owner.query(
      "INSERT INTO berth_ledger.requests(id,attempt,operation,generation,meter,mutation,reserved_at) VALUES($1,$2,$3,1,'cleanup',true,$4)",
      [
        randomUUID(),
        oldAttempt,
        trial.operation,
        new Date(when + 2).toISOString(),
      ],
    );
    const checkpoint = (
      await owner.query("SELECT berth_executor.report($1) AS value", [
        trial.operation,
      ])
    ).rows[0]?.value;
    assert.equal((await readInventory()).coverage, "incomplete");
    await assert.rejects(call(db, present), { code: "42501" });
    await assert.rejects(
      db.query("SELECT * FROM berth_inventory.executor_events"),
      { code: "42501" },
    );
    await owner.query(
      "GRANT berth_inventory_recorder TO neondb_owner WITH SET TRUE",
    );
    await owner.query("SET ROLE berth_inventory_recorder");
    try {
      await assert.rejects(
        call(owner, {
          ...present,
          bucket: { ...present.bucket, compartment: "different" },
        }),
        { message: "Owner receipt rejected" },
      );
      assert.equal(await call(owner, present), "recorded");
      assert.equal(await call(owner, present), "already-recorded");
      await owner.query("RESET ROLE");
      assert.equal(
        (await readInventory()).items[0]?.uncertainty,
        "delete-unresolved",
      );
      await owner.query("SET ROLE berth_inventory_recorder");
      assert.equal(
        await call(owner, {
          ...present,
          reference: "fixture/after-delete-reservation",
          observedAt: new Date(when + 3).toISOString(),
          observation: { status: 200, requestId: "fixture-later-presence" },
        }),
        "recorded",
      );
      await owner.query("RESET ROLE");
      assert.equal(
        (await readInventory()).items[0]?.uncertainty,
        "delete-unresolved",
      );
      await owner.query("SET ROLE berth_inventory_recorder");
      await assert.rejects(
        call(owner, {
          ...present,
          observation: { status: 200, requestId: 12345 },
        }),
        { message: "Owner receipt rejected" },
      );
      await assert.rejects(
        owner.query("SELECT * FROM berth_inventory.evidence"),
        { code: "42501" },
      );
      const removal = {
        ...present,
        reference: "fixture/removal",
        observedAt: new Date(when + 4).toISOString(),
        kind: "removed",
        observation: {
          deleteStatus: 204,
          ifMatch: "fixture-revision",
          absentStatus: 404,
          listingComplete: true,
          targetListed: false,
          deleteRequestId: "fixture-delete",
          getRequestId: "fixture-absence",
          listRequestId: "fixture-list",
        },
      };
      await assert.rejects(
        call(owner, { ...removal, observation: { absentStatus: 404 } }),
        { message: "Owner receipt rejected" },
      );
      assert.equal(await call(owner, removal), "recorded");
      assert.equal(
        await call(owner, {
          ...present,
          observation: { status: 200, requestId: "different-id" },
        }),
        "conflict",
      );
      assert.equal(
        await call(owner, {
          ...present,
          reference: "fixture/late",
          observation: { status: 200, requestId: "fixture-late" },
          observedAt: new Date(when + 2).toISOString(),
        }),
        "recorded",
      );
      assert.equal(
        await call(owner, {
          ...present,
          reference: "fixture/conflict",
          observation: { status: 200, requestId: "fixture-conflict" },
          observedAt: new Date(when + 5).toISOString(),
        }),
        "conflict",
      );
    } finally {
      await owner.query("RESET ROLE");
    }
    assert.deepEqual((await readInventory()).items, []);
    assert.equal((await readInventory()).coverage, "incomplete");
    assert.deepEqual(
      (
        await owner.query("SELECT berth_executor.report($1) AS value", [
          trial.operation,
        ])
      ).rows[0]?.value,
      checkpoint,
    );
  }));

test("unresolved create leaves a coverage gap and unresolved deletion retains the identified instance", () =>
  inventoryFixture(async (owner, db) => {
    const trial = await start(db);
    class InterruptedBucket extends FakeObjects {
      override async createBucket(
        r: Parameters<FakeObjects["createBucket"]>[0],
      ): Promise<never> {
        await super.createBucket(r);
        throw { statusCode: 500 };
      }

      loseNextListing = false;
      override async listBuckets(r: Parameters<FakeObjects["listBuckets"]>[0]) {
        const response = await super.listBuckets(r);
        if (this.loseNextListing) {
          this.loseNextListing = false;
          return { items: [] };
        }
        return response;
      }

      override async deleteBucket(
        r: Parameters<FakeObjects["deleteBucket"]>[0],
      ): Promise<never> {
        await super.deleteBucket(r);
        throw { statusCode: 500 };
      }
    }
    const sdk = new InterruptedBucket();
    const run = (n: number) =>
      runExecutor(db, {
        operation: trial.operation,
        delivery: delivery(n),
        expiresAt: Date.parse(trial.expires_at),
        sdk: () => sdk,
      });
    const readInventory = async () =>
      (await owner.query("SELECT berth_inventory.inventory_page() AS value"))
        .rows[0]?.value;
    assert.deepEqual(await run(820), { phase: "needs-reconciliation" });
    assert.deepEqual(await readInventory(), {
      offering: "oci-object-storage-bucket",
      coverage: "incomplete",
      items: [],
      next: null,
    });
    sdk.loseNextListing = true;
    assert.deepEqual(await run(821), { phase: "needs-reconciliation" });
    assert.deepEqual((await readInventory()).items, []);
    assert.equal(sdk.deletes, 0);
    assert.deepEqual(await run(822), { phase: "needs-reconciliation" });
    const uncertain = (await readInventory()).items[0];
    assert.equal(uncertain?.operation, trial.operation);
    assert.equal(uncertain?.presence, "uncertain");
    assert.equal(uncertain?.uncertainty, "delete-unresolved");
    assert.ok(uncertain?.lastVerifiedAt);
    assert.equal(sdk.creates, 1);
    assert.equal(sdk.deletes, 1);
    assert.deepEqual(await run(823), { phase: "terminal" });
    assert.deepEqual((await readInventory()).items, []);
    assert.equal(sdk.deletes, 1);
  }));

test("an open owner evidence transaction cannot fence cleanup or lose the verified deletion proof", () =>
  inventoryFixture(async (owner, db) => {
    const trial = await start(db);
    const sdk = new FakeObjects();
    const run = (n: number) =>
      runExecutor(db, {
        operation: trial.operation,
        delivery: delivery(n),
        expiresAt: Date.parse(trial.expires_at),
        sdk: () => sdk,
      });
    assert.deepEqual(await run(830), { phase: "object" });
    assert.deepEqual(await run(831), { phase: "cleanup" });
    const bucket = sdk.value;
    assert.ok(bucket?.id);
    await owner.query(
      "GRANT berth_inventory_recorder TO neondb_owner WITH SET TRUE",
    );
    await owner.query("BEGIN");
    try {
      await owner.query("SET LOCAL ROLE berth_inventory_recorder");
      const receipt = {
        reference: "fixture/held",
        operation: trial.operation,
        observedAt: new Date().toISOString(),
        kind: "present",
        bucket: {
          id: bucket.id,
          region: trial.region,
          namespace: trial.namespace,
          compartment: trial.compartment,
          name: trial.bucket,
          operationTag: trial.operation,
          marker: bucket.freeformTags?.["berth-marker"],
          etag: bucket.etag,
        },
        observation: { status: 200, requestId: "fixture-held-get" },
      };
      assert.equal(
        (
          await owner.query(
            "SELECT berth_inventory.submit_owner_receipt($1::jsonb) AS outcome",
            [JSON.stringify(receipt)],
          )
        ).rows[0]?.outcome,
        "recorded",
      );
      assert.deepEqual(await run(832), { phase: "terminal" });
      assert.equal(sdk.deletes, 1);
    } finally {
      await owner.query("ROLLBACK");
    }
    const pending = (
      await owner.query("SELECT berth_inventory.inventory_page() AS value")
    ).rows[0]?.value;
    assert.equal(pending.items[0]?.uncertainty, "delete-unresolved");
    assert.deepEqual(await run(833), { phase: "terminal" });
    assert.equal(sdk.deletes, 1);
    const published = (
      await owner.query("SELECT berth_inventory.inventory_page() AS value")
    ).rows[0]?.value;
    assert.deepEqual(published.items, []);
  }));

test("failure of the evidence writer cannot consume cleanup capacity without dispatch", () =>
  inventoryFixture(async (owner, db) => {
    const trial = await start(db);
    const sdk = new FakeObjects();
    const faultingEvidence = {
      async query(sql: string, args?: unknown[]) {
        if (sql.startsWith("SELECT berth_inventory.executor_receipt("))
          throw Error("fixture evidence unavailable");
        return db.query(sql, args);
      },
    };
    const run = (n: number) =>
      runExecutor(faultingEvidence, {
        operation: trial.operation,
        delivery: delivery(n),
        expiresAt: Date.parse(trial.expires_at),
        sdk: () => sdk,
      });
    assert.deepEqual(await run(840), { phase: "object" });
    assert.deepEqual(await run(841), { phase: "cleanup" });
    assert.deepEqual(await run(842), { phase: "terminal" });
    assert.equal(sdk.deletes, 1);
    const page = (
      await owner.query("SELECT berth_inventory.inventory_page() AS value")
    ).rows[0]?.value;
    assert.equal(page.items[0]?.uncertainty, "delete-unresolved");
    const requests = await owner.query(
      `SELECT r.outcome FROM berth_ledger.requests r
       JOIN berth_ledger.attempts a ON a.id = r.attempt
       WHERE a.action = 'delete_bucket'`,
    );
    assert.deepEqual(requests.rows, [{ outcome: "succeeded" }]);
  }));
