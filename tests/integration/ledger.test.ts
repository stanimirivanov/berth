import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Client } from "pg";
import { makeTrialApi } from "../../src/trial/api.js";
import { makeLedger } from "../../src/trial/ledger.js";
import {
  config as apiConfig,
  evidence as apiEvidence,
} from "../fakes/admission.js";

test("ledger serializes active trials, fences stale writers and preserves unknown dispatches", async () => {
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
  });
  const a = new Client({
    ...config,
    user: "berth_runtime",
    password: "test-runtime-only",
  });
  const b = new Client({
    ...config,
    user: "berth_runtime",
    password: "test-runtime-only",
  });
  let installed = false;
  try {
    await owner.connect();
    await a.connect();
    await b.connect();
    await owner.query(await readFile("migrations/001_trial.sql", "utf8"));
    installed = true;
    const left = makeLedger(a),
      right = makeLedger(b);
    const intent = {
      operation: randomUUID(),
      compartment: "ocid1.compartment.oc1..fixture",
      region: "eu-frankfurt-1",
      namespace: "fixture",
      digest: "a".repeat(64),
      monitoringLimit: 12,
      neonLimit: 48,
    };
    const starts = await Promise.allSettled([
      left.start(intent),
      right.start({ ...intent, operation: randomUUID() }),
    ]);
    assert.equal(starts.filter((x) => x.status === "fulfilled").length, 1);
    const winner = starts.find((x) => x.status === "fulfilled");
    assert.ok(winner?.status === "fulfilled");
    const operation = winner.value.operation;
    const claims = await Promise.allSettled([
      left.claim(operation, randomUUID()),
      right.claim(operation, randomUUID()),
    ]);
    assert.equal(claims.filter((x) => x.status === "fulfilled").length, 1);
    const owned = claims.find((x) => x.status === "fulfilled");
    assert.ok(owned?.status === "fulfilled");
    const claim = owned.value;
    const attempt = await left.begin(claim, randomUUID(), "create_bucket");
    const rejected = await left.reserve(claim, attempt, randomUUID());
    await left.settle(claim, rejected.id, "rejected", "provider-response");
    await assert.rejects(left.reserve(claim, attempt, randomUUID()));
    await left.end(claim, attempt, "failed");
    const nextAttempt = await left.begin(claim, randomUUID(), "create_bucket");
    const request = await left.reserve(claim, nextAttempt, randomUUID());
    assert.equal(request.fresh, true);
    const duplicate = await right.reserve(claim, nextAttempt, request.id);
    assert.equal(duplicate.fresh, false);
    await owner.query(
      "UPDATE berth_ledger.trials SET lease_until=clock_timestamp()-interval '1 second'",
    );
    const fresh = await right.claim(operation, randomUUID());
    assert.ok(BigInt(fresh.generation) > BigInt(claim.generation));
    await assert.rejects(
      left.settle(claim, request.id, "succeeded", "provider-response"),
    );
    await assert.rejects(right.begin(fresh, randomUUID(), "delete_bucket"));
    await assert.rejects(right.finish(fresh, "succeeded"));
    await assert.rejects(
      right.settle(fresh, request.id, "succeeded", "provider-response"),
    );
    await right.settle(fresh, request.id, "succeeded", "reconciled-provider");
    await right.end(fresh, nextAttempt, "succeeded");
    const inspect = await right.begin(fresh, randomUUID(), "inspect");
    // All requests remain spent, including an ambiguous response after SQL commits.
    const lostId = randomUUID();
    const lost = makeLedger({
      query: async (text, values) => {
        await b.query(text, values);
        throw Error("lost response");
      },
    });
    await assert.rejects(lost.reserve(fresh, inspect, lostId));
    assert.equal((await right.reserve(fresh, inspect, lostId)).fresh, false);
    const counts = await owner.query(
      "SELECT normal_used FROM berth_ledger.trials",
    );
    assert.equal(counts.rows[0].normal_used, 3);
    await assert.rejects(
      a.query("UPDATE berth_ledger.trials SET normal_used=0"),
      /permission denied/,
    );
    await assert.rejects(
      a.query("DELETE FROM berth_ledger.requests"),
      /permission denied/,
    );
    await assert.rejects(
      a.query("CREATE TABLE berth_ledger.bypass(id int)"),
      /permission denied/,
    );
    await right.settle(fresh, lostId, "rejected", "provider-response");
    await right.end(fresh, inspect, "failed");
    await assert.rejects(right.finish(fresh, "succeeded"));
    await assert.rejects(right.finish(fresh, "failed"));
    const deletion = await right.begin(fresh, randomUUID(), "delete_bucket");
    const deletionRequest = await right.reserve(fresh, deletion, randomUUID());
    await right.settle(
      fresh,
      deletionRequest.id,
      "succeeded",
      "provider-response",
    );
    await right.end(fresh, deletion, "succeeded");
    await right.finish(fresh, "succeeded");
    const terminal = await left.start({ ...intent, operation });
    assert.equal(terminal.outcome, "succeeded");
    assert.equal(terminal.marker, winner.value.marker);
    assert.equal(
      (
        await owner.query(
          "SELECT outcome FROM berth_ledger.trials WHERE operation=$1",
          [operation],
        )
      ).rows[0].outcome,
      "succeeded",
    );
  } finally {
    await a.end();
    await b.end();
    if (installed) await owner.query("DROP SCHEMA berth_ledger CASCADE");
    await owner.end();
  }
});

test("ledger races cannot overspend normal, cleanup, monitoring or Neon allowances", async () => {
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
  });
  const a = new Client({
      ...config,
      user: "berth_runtime",
      password: "test-runtime-only",
    }),
    b = new Client({
      ...config,
      user: "berth_runtime",
      password: "test-runtime-only",
    });
  let installed = false;
  try {
    await owner.connect();
    await a.connect();
    await b.connect();
    await owner.query(await readFile("migrations/001_trial.sql", "utf8"));
    installed = true;
    const x = makeLedger(a),
      y = makeLedger(b),
      operation = randomUUID();
    await x.start({
      operation,
      compartment: "ocid1.compartment.oc1..fixture",
      region: "eu-frankfurt-1",
      namespace: "fixture",
      digest: "b".repeat(64),
      monitoringLimit: 2,
      neonLimit: 3,
    });
    const c = await x.claim(operation, randomUUID(), 60);
    const normal = await x.begin(c, randomUUID(), "inspect");
    const race = async (attempt: string, perClient: number) =>
      (
        await Promise.all(
          [x, y].map(async (ledger) => {
            const results: boolean[] = [];
            for (let i = 0; i < perClient; i++) {
              try {
                await ledger.reserve(c, attempt, randomUUID());
                results.push(true);
              } catch {
                results.push(false);
              }
            }
            return results;
          }),
        )
      ).flat();
    const outcomes = await race(normal, 90);
    assert.equal(outcomes.filter(Boolean).length, 160);
    const cleanup = await x.begin(c, randomUUID(), "inspect_cleanup");
    const cleans = await race(cleanup, 30);
    assert.equal(cleans.filter(Boolean).length, 40);
    await assert.rejects(x.begin(c, randomUUID(), "put_object"));
    const monitor = await x.begin(c, randomUUID(), "monitor"),
      invoke = await x.begin(c, randomUUID(), "invoke");
    await x.release(c);
    const resumed = await y.claim(operation, randomUUID(), 60);
    assert.equal(await y.begin(resumed, monitor, "monitor"), monitor);
    const c2 = resumed;
    for (let i = 0; i < 2; i++) await x.reserve(c2, monitor, randomUUID());
    await assert.rejects(x.reserve(c2, monitor, randomUUID()));
    for (let i = 0; i < 3; i++) await x.reserve(c2, invoke, randomUUID());
    await assert.rejects(x.reserve(c2, invoke, randomUUID()));
    await x.begin(c2, randomUUID(), "inspect");
    await x.begin(c2, randomUUID(), "inspect");
    await assert.rejects(x.begin(c2, randomUUID(), "inspect"));
    const row = (
      await owner.query(
        "SELECT normal_used,cleanup_used,monitoring_used,neon_used FROM berth_ledger.trials",
      )
    ).rows[0];
    assert.deepEqual(row, {
      normal_used: 160,
      cleanup_used: 40,
      monitoring_used: 2,
      neon_used: 3,
    });
    assert.equal(
      (
        await owner.query(
          "SELECT count(*)::int AS n FROM berth_ledger.requests",
        )
      ).rows[0].n,
      205,
    );
    await owner.query(
      "UPDATE berth_ledger.trials SET expires_at=clock_timestamp()-interval '1 second'",
    );
    await assert.rejects(x.reserve(c2, monitor, randomUUID()));
  } finally {
    await a.end();
    await b.end();
    if (installed) await owner.query("DROP SCHEMA berth_ledger CASCADE");
    await owner.end();
  }
});

test("ledger survives backend termination before reservation, before commit and after dispatch intent commit", async () => {
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
    admin = new Client({
      ...config,
      user: "postgres",
      password: "berth-test-only",
    });
  const clients: Client[] = [];
  let installed = false;
  const connect = async () => {
    const db = new Client({
      ...config,
      user: "berth_runtime",
      password: "test-runtime-only",
    });
    db.on("error", () => {});
    await db.connect();
    clients.push(db);
    return db;
  };
  const kill = async (db: Client) => {
    const pid = (await db.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    await admin.query("SELECT pg_terminate_backend($1)", [pid]);
    await new Promise((resolve) => setTimeout(resolve, 1100));
  };
  try {
    await owner.connect();
    await admin.connect();
    await owner.query(await readFile("migrations/001_trial.sql", "utf8"));
    installed = true;
    const operation = randomUUID();
    const a = await connect();
    let ledger = makeLedger(a);
    await ledger.start({
      operation,
      compartment: "ocid1.compartment.oc1..fixture",
      region: "eu-frankfurt-1",
      namespace: "fixture",
      digest: "c".repeat(64),
      monitoringLimit: 12,
      neonLimit: 48,
    });
    let c = await ledger.claim(operation, randomUUID(), 1);
    let attempt = await ledger.begin(c, randomUUID(), "create_bucket");
    await kill(a);
    assert.equal(
      (
        await owner.query(
          "SELECT count(*)::int AS n FROM berth_ledger.requests",
        )
      ).rows[0].n,
      0,
    );
    const b = await connect();
    ledger = makeLedger(b);
    c = await ledger.claim(operation, randomUUID(), 1);
    await ledger.end(c, attempt, "failed");
    attempt = await ledger.begin(c, randomUUID(), "create_bucket");
    await b.query("BEGIN");
    await ledger.reserve(c, attempt, randomUUID());
    await kill(b);
    assert.equal(
      (await owner.query("SELECT normal_used FROM berth_ledger.trials")).rows[0]
        .normal_used,
      0,
    );
    const d = await connect();
    ledger = makeLedger(d);
    c = await ledger.claim(operation, randomUUID(), 1);
    await ledger.end(c, attempt, "failed");
    attempt = await ledger.begin(c, randomUUID(), "create_bucket");
    const receipt = await ledger.reserve(c, attempt, randomUUID());
    await kill(d);
    const e = await connect();
    ledger = makeLedger(e);
    c = await ledger.claim(operation, randomUUID());
    assert.equal(
      (await owner.query("SELECT normal_used FROM berth_ledger.trials")).rows[0]
        .normal_used,
      1,
    );
    assert.equal(
      (
        await owner.query(
          "SELECT outcome FROM berth_ledger.requests WHERE id=$1",
          [receipt.id],
        )
      ).rows[0].outcome,
      "unresolved",
    );
    await assert.rejects(ledger.begin(c, randomUUID(), "delete_bucket"));
    await assert.rejects(ledger.finish(c, "succeeded"));
    await ledger.finish(c, "needs-reconciliation");
    await assert.rejects(
      ledger.start({
        operation: randomUUID(),
        compartment: "ocid1.compartment.oc1..fixture",
        region: "eu-frankfurt-1",
        namespace: "fixture",
        digest: "c".repeat(64),
        monitoringLimit: 12,
        neonLimit: 48,
      }),
    );
  } finally {
    for (const db of clients) await db.end();
    await admin.end();
    if (installed) await owner.query("DROP SCHEMA berth_ledger CASCADE");
    await owner.end();
  }
});

test("ledger intent is immutable, time windows fail closed and reconciliation retains the active slot", async () => {
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
    const ledger = makeLedger(db);
    const intent = {
      operation: randomUUID(),
      compartment: "ocid1.compartment.oc1..fixture",
      region: "eu-frankfurt-1",
      namespace: "fixture",
      digest: "d".repeat(64),
      monitoringLimit: 12,
      neonLimit: 48,
    };
    const first = await ledger.start(intent);
    assert.deepEqual(await ledger.start(intent), first);
    assert.notEqual(first.marker, intent.operation);
    assert.equal(first.bucket, `berth-${intent.operation.replaceAll("-", "")}`);
    await assert.rejects(ledger.start({ ...intent, digest: "e".repeat(64) }));
    let claim = await ledger.claim(intent.operation, randomUUID());
    await ledger.finish(claim, "needs-reconciliation");
    await assert.rejects(ledger.begin(claim, randomUUID(), "create_bucket"));
    await assert.rejects(ledger.start({ ...intent, operation: randomUUID() }));
    await ledger.finish(claim, "failed");
    const next = { ...intent, operation: randomUUID() };
    await ledger.start(next);
    claim = await ledger.claim(next.operation, randomUUID());
    const attempt = await ledger.begin(claim, randomUUID(), "put_object");
    await owner.query(
      "UPDATE berth_ledger.trials SET started_at=clock_timestamp()-interval '31 minutes' WHERE operation=$1",
      [next.operation],
    );
    await assert.rejects(ledger.reserve(claim, attempt, randomUUID()));
    await assert.rejects(ledger.begin(claim, randomUUID(), "create_bucket"));
    const cleanup = await ledger.begin(claim, randomUUID(), "delete_object");
    assert.equal(
      (await ledger.reserve(claim, cleanup, randomUUID())).fresh,
      true,
    );
    await owner.query(
      "UPDATE berth_ledger.trials SET expires_at=clock_timestamp()-interval '1 second' WHERE operation=$1",
      [next.operation],
    );
    await assert.rejects(ledger.begin(claim, randomUUID(), "inspect_cleanup"));
    assert.equal(
      (
        await owner.query(
          "SELECT cleanup_used,normal_used FROM berth_ledger.trials WHERE operation=$1",
          [next.operation],
        )
      ).rows[0].normal_used,
      0,
    );
  } finally {
    await db.end();
    if (installed) await owner.query("DROP SCHEMA berth_ledger CASCADE");
    await owner.end();
  }
});

test("API instances concurrently submit one signed preview into one durable ledger intent", async () => {
  const port = Number(process.env.BERTH_TEST_POSTGRES_PORT);
  assert.ok(Number.isInteger(port) && port > 0 && port < 65536);
  const connection = {
    host: "127.0.0.1",
    port,
    database: "neondb",
    connectionTimeoutMillis: 3000,
    statement_timeout: 5000,
  };
  const owner = new Client({
    ...connection,
    user: "neondb_owner",
    password: "berth-test-only",
  });
  const a = new Client({
      ...connection,
      user: "berth_runtime",
      password: "test-runtime-only",
    }),
    b = new Client({
      ...connection,
      user: "berth_runtime",
      password: "test-runtime-only",
    });
  let installed = false;
  try {
    await owner.connect();
    await a.connect();
    await b.connect();
    await owner.query(await readFile("migrations/001_trial.sql", "utf8"));
    installed = true;
    const options = {
      token: "a".repeat(40),
      previewKey: "b".repeat(40),
      configuration: apiConfig,
      headroom: async () => ({ ...apiEvidence, checkedAt: Date.now() }),
      verifyCredentials: async () => true,
      async admitCleanup(): Promise<never> {
        throw Error("not wired");
      },
    };
    const left = makeTrialApi({ ...options, ledger: makeLedger(a) }),
      right = makeTrialApi({ ...options, ledger: makeLedger(b) });
    const request = (route: string, body: unknown = {}) =>
      new Request(`https://trial.invalid/${route}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${options.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
    const preview = await (await left.fetch(request("preview"))).json();
    assert.equal(
      (
        await owner.query(
          "SELECT count(*)::int AS count FROM berth_ledger.trials",
        )
      ).rows[0].count,
      0,
    );
    const responses = await Promise.all([
      left.fetch(request("submit", { preview: preview.preview })),
      right.fetch(request("submit", { preview: preview.preview })),
    ]);
    assert.deepEqual(
      responses.map((r) => r.status),
      [202, 202],
    );
    const [one, two] = await Promise.all(responses.map((r) => r.json()));
    assert.deepEqual(one, two);
    const stored = (await owner.query("SELECT * FROM berth_ledger.trials"))
      .rows;
    assert.equal(stored.length, 1);
    assert.equal(stored[0].bucket, preview.proposal.bucket.name);
    assert.equal(stored[0].digest, preview.proposal.object.sha256);
    assert.equal(one.runtimeExpiresAt, stored[0].expires_at.toISOString());
    assert.equal(one.deploymentExpiresAt, one.runtimeExpiresAt);
    const other = await (await right.fetch(request("preview"))).json();
    assert.equal(
      (await right.fetch(request("submit", { preview: other.preview }))).status,
      503,
    );
  } finally {
    await a.end();
    await b.end();
    if (installed) await owner.query("DROP SCHEMA berth_ledger CASCADE");
    await owner.end();
  }
});
