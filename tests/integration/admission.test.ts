import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Client } from "pg";
import { makeLedger } from "../../src/trial/ledger.js";

test("prepared admission refuses mutations, charges credential requests, admits once and preserves cleanup", async () => {
  const port = Number(process.env.BERTH_TEST_POSTGRES_PORT);
  assert.ok(port > 0 && port < 65536);
  const owner = new Client({
    host: "127.0.0.1",
    port,
    database: "neondb",
    user: "neondb_owner",
    password: "berth-test-only",
  });
  const db = new Client({
    host: "127.0.0.1",
    port,
    database: "neondb",
    user: "berth_runtime",
    password: "test-runtime-only",
  });
  await owner.connect();
  await db.connect();
  try {
    for (const name of [
      "001_trial",
      "002_executor",
      "003_usage",
      "004_admission",
    ])
      await owner.query(await readFile(`migrations/${name}.sql`, "utf8"));
    const operation = randomUUID(),
      start = new Date(Date.now() - 1000).toISOString();
    const binding = {
      compartment: "ocid1.compartment.oc1..fixture",
      namespace: "fixture",
      region: "eu-frankfurt-1",
      monitoringLimit: 20,
      neonLimit: 40,
      tenancy: "ocid1.tenancy.oc1..fixture",
      user: "ocid1.user.oc1..fixture",
      fingerprint: "fixture",
    };
    const evidence = {
      checkedAt: Date.now(),
      iamCheckedAt: Date.now(),
      iamReviewed: true,
      accountType: "always-free",
      homeRegion: binding.region,
      storageBytes: 10485760,
      objectRequests: 200,
      transferBytes: 1048576,
      monitoringRequests: 20,
      neonFree: true,
      neonInvocations: 40,
      neonComputeSeconds: 1000,
      measuredComputeSeconds: 500,
    };
    await owner.query("SELECT berth_executor.prepare($1,$2,$3,$4)", [
      operation,
      start,
      JSON.stringify(binding),
      JSON.stringify(evidence),
    ]);
    const { meterAdmission, verifyAdmission } = await import(
      "../../src/trial/live-admission.js"
    );
    const e = {
      ...binding,
      operation,
      startedAt: Date.parse(start),
      expiresAt: Date.parse(start) + 14400000,
      token: "a".repeat(40),
      previewKey: "b".repeat(40),
      privateKey: generateKeyPairSync("rsa", { modulusLength: 2048 })
        .privateKey.export({ type: "pkcs8", format: "pem" })
        .toString(),
      connection: "unused",
    };
    await meterAdmission(db, e);
    const { liveAdmissionApi: readinessApi } = await import(
      "../../src/trial/live-admission.js"
    );
    for (const invalid of [
      { ...evidence, iamReviewed: false },
      { ...evidence, iamCheckedAt: Date.now() + 10000 },
      { ...evidence, checkedAt: Date.now() - 86401000 },
      { ...evidence, checkedAt: Date.now() - 86340000 },
      { ...evidence, iamCheckedAt: Date.now() - 86340000 },
    ]) {
      await owner.query(
        "UPDATE berth_executor.admission SET evidence=$2 WHERE operation=$1",
        [operation, JSON.stringify(invalid)],
      );
      const blocked = await readinessApi(db, e, async () => {
        throw Error("stale evidence must not dispatch");
      }).fetch(
        new Request("https://fixture/preview", {
          method: "POST",
          headers: {
            authorization: `Bearer ${e.token}`,
            "content-type": "application/json",
          },
          body: "{}",
        }),
      );
      assert.equal(blocked.status, 409);
    }
    await owner.query(
      "UPDATE berth_executor.admission SET evidence=$2 WHERE operation=$1",
      [operation, JSON.stringify(evidence)],
    );

    let reservationLost = true,
      prematureSends = 0;
    await assert.rejects(
      verifyAdmission(
        {
          query: async (text, values) => {
            const result = await db.query(text, values);
            if (text.includes("berth_ledger.reserve(") && reservationLost) {
              reservationLost = false;
              throw Error("lost reservation response");
            }
            return result;
          },
        },
        e,
        async () => {
          prematureSends++;
          return true;
        },
      ),
    );
    assert.equal(prematureSends, 0);

    let sends = 0;
    assert.equal(
      await verifyAdmission(db, e, async () => {
        sends++;
        return true;
      }),
      true,
    );
    assert.equal(
      await verifyAdmission(db, e, async () => {
        throw Error("cached checks must not dispatch");
      }),
      true,
    );
    assert.equal(sends, 2);
    const ledger = makeLedger(db),
      claim = await ledger.claim(operation, randomUUID());
    await assert.rejects(ledger.begin(claim, randomUUID(), "create_bucket"));
    const inspection = await ledger.begin(claim, randomUUID(), "inspect");
    const ids = [randomUUID(), randomUUID()];
    for (const id of ids) {
      assert.equal((await ledger.reserve(claim, inspection, id)).fresh, true);
      await ledger.settle(claim, id, "succeeded", "provider-response");
    }
    await db.query("SELECT berth_executor.admission_verified($1,$2,$3,$4,$5)", [
      operation,
      claim.owner,
      claim.generation,
      JSON.stringify(binding),
      inspection,
    ]);
    await ledger.release(claim);
    await assert.rejects(
      db.query("SELECT berth_executor.admit($1,$2)", [
        operation,
        JSON.stringify({ ...binding, namespace: "wrong" }),
      ]),
    );
    const { liveAdmissionApi } = await import(
      "../../src/trial/live-admission.js"
    );
    const request = (path: string, body: unknown) =>
      new Request(`https://fixture/${path}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${e.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
    const api = liveAdmissionApi(db, e, async () => {
      throw Error("must use cached verification");
    });
    const preview = await (await api.fetch(request("preview", {}))).json();
    assert.ok(preview.preview);
    let lost = true;
    const uncertain = liveAdmissionApi(
      {
        query: async (text, values) => {
          const result = await db.query(text, values);
          if (text.includes("berth_executor.admit(") && lost) {
            lost = false;
            throw Error("private-lost-response");
          }
          return result;
        },
      },
      e,
      async () => {
        throw Error("must use cache");
      },
    );
    const failed = await uncertain.fetch(
      request("submit", { preview: preview.preview }),
    );
    assert.equal(failed.status, 503);
    const failure = await failed.json();
    assert.equal(failure.operation, operation);
    assert.ok(!JSON.stringify(failure).includes("private-lost-response"));
    assert.equal(
      (await api.fetch(request("submit", { preview: preview.preview }))).status,
      202,
    );
    assert.equal(
      (
        await db.query("SELECT berth_executor.admit($1,$2) AS fresh", [
          operation,
          JSON.stringify(binding),
        ])
      ).rows[0].fresh,
      false,
    );
    const c = await ledger.claim(operation, randomUUID());
    const attempt = await ledger.begin(c, randomUUID(), "create_bucket");
    await db.query("SELECT berth_executor.cleanup($1)", [operation]);
    await assert.rejects(ledger.reserve(c, attempt, randomUUID()));
    const cleanup = await ledger.begin(c, randomUUID(), "inspect_cleanup");
    await ledger.reserve(c, cleanup, randomUUID());
    const state = (await ledger.read(c)) as {
      trial: { normal_used: number; cleanup_used: number };
    };
    assert.equal(state.trial.normal_used, 5);
    assert.equal(state.trial.cleanup_used, 1);
    await owner.query(
      "UPDATE berth_ledger.trials SET neon_used=neon_limit-12 WHERE operation=$1",
      [operation],
    );
    await assert.rejects(meterAdmission(db, e, "control"));
    await meterAdmission(db, e, "cleanup");
    const larger = { ...e, neonLimit: 100 };
    await owner.query(
      "UPDATE berth_ledger.trials SET neon_limit=100,neon_used=0 WHERE operation=$1",
      [operation],
    );
    await owner.query(
      "UPDATE berth_executor.admission SET binding=$2 WHERE operation=$1",
      [operation, JSON.stringify({ ...binding, neonLimit: 100 })],
    );
    await owner.query(
      "INSERT INTO berth_executor.http_receipts(id,operation,purpose,reserved_cleanup) SELECT gen_random_uuid(),$1,'control',false FROM generate_series(1,52-(SELECT count(*)::int FROM berth_executor.http_receipts WHERE operation=$1 AND NOT reserved_cleanup))",
      [operation],
    );
    await assert.rejects(meterAdmission(db, larger, "control"));
    await assert.rejects(meterAdmission(db, larger, "cleanup"));

    await assert.rejects(
      db.query("UPDATE berth_executor.admission SET admitted=true"),
    );
    await owner.query(
      "UPDATE berth_ledger.trials SET cleanup_started=false,neon_used=neon_limit-13 WHERE operation=$1",
      [operation],
    );
    await owner.query(
      "UPDATE berth_executor.work SET cleanup_requested=false WHERE operation=$1",
      [operation],
    );
    const invocation = await ledger.begin(c, randomUUID(), "invoke");
    const pid = (await db.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    await owner.query("BEGIN");
    await owner.query(
      "UPDATE berth_ledger.trials SET neon_used=neon_limit-12 WHERE operation=$1",
      [operation],
    );
    const racing = ledger.reserve(c, invocation, randomUUID()).then(
      () => "accepted",
      () => "rejected",
    );
    let waiting = false;
    for (let i = 0; i < 50; i++) {
      waiting =
        (
          await owner.query(
            "SELECT EXISTS(SELECT FROM pg_locks WHERE pid=$1 AND NOT granted) AS waiting",
            [pid],
          )
        ).rows[0]?.waiting === true;
      if (waiting) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
      await owner.query("SELECT pg_stat_clear_snapshot()");
    }
    await owner.query("COMMIT");
    assert.equal(waiting, true, "reservation reached a real row-lock wait");
    assert.equal(
      await racing,
      "rejected",
      "concurrent metering must not consume cleanup reserve",
    );
    await owner.query(
      "UPDATE berth_executor.admission SET admitted=false,verified_at=clock_timestamp() WHERE operation=$1",
      [operation],
    );
    await owner.query(
      "UPDATE berth_ledger.trials SET started_at=clock_timestamp()-interval '5 minutes',expires_at=clock_timestamp()+interval '235 minutes' WHERE operation=$1",
      [operation],
    );
    await assert.rejects(
      db.query("SELECT berth_executor.admit($1,$2)", [
        operation,
        JSON.stringify({ ...binding, neonLimit: 100 }),
      ]),
      /Admission evidence or creation margin rejected/,
    );
    await owner.query(
      "DELETE FROM berth_executor.admission WHERE operation=$1",
      [operation],
    );
    await owner.query(
      "UPDATE berth_ledger.trials SET cleanup_started=false WHERE operation=$1",
      [operation],
    );
    await owner.query(
      "UPDATE berth_executor.work SET cleanup_requested=false WHERE operation=$1",
      [operation],
    );
    await assert.rejects(ledger.begin(c, randomUUID(), "put_object"));

    await assert.rejects(
      db.query("SELECT berth_ledger.begin_attempt_unadmitted($1,$2,$3,$4,$5)", [
        operation,
        c.owner,
        c.generation,
        randomUUID(),
        "create_bucket",
      ]),
    );
  } finally {
    await db.end();
    for (const schema of ["berth_usage", "berth_executor", "berth_ledger"])
      await owner.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await owner.end();
  }
});

test("one hosted delivery creates and uploads under one deadline and replay does not recreate", async () => {
  const port = Number(process.env.BERTH_TEST_POSTGRES_PORT);
  assert.ok(port > 0 && port < 65536);
  const owner = new Client({
    host: "127.0.0.1",
    port,
    database: "neondb",
    user: "neondb_owner",
    password: "berth-test-only",
  });
  await owner.connect();
  try {
    for (const name of [
      "001_trial",
      "002_executor",
      "003_usage",
      "004_admission",
    ])
      await owner.query(await readFile(`migrations/${name}.sql`, "utf8"));
    const { FakeObjects } = await import("../fakes/oci.js"),
      { executeLive } = await import("../../src/trial/live-runtime.js");
    const cloud = new FakeObjects(),
      operation = randomUUID(),
      startedAt = Date.now() - 1000;
    const binding = {
      compartment: "ocid1.compartment.oc1..fixture",
      namespace: "fixture",
      region: "eu-frankfurt-1",
      monitoringLimit: 20,
      neonLimit: 64,
      tenancy: "ocid1.tenancy.oc1..fixture",
      user: "ocid1.user.oc1..fixture",
      fingerprint: "fixture",
    };
    const e = {
      ...binding,
      operation,
      startedAt,
      expiresAt: startedAt + 14400000,
      token: "a".repeat(40),
      previewKey: "b".repeat(40),
      privateKey: generateKeyPairSync("rsa", { modulusLength: 2048 })
        .privateKey.export({ type: "pkcs8", format: "pem" })
        .toString(),
      connection: "unused",
    };
    await owner.query("SELECT berth_executor.prepare($1,$2,$3,$4)", [
      operation,
      new Date(startedAt).toISOString(),
      JSON.stringify(binding),
      "{}",
    ]);
    // Owner fixture emulates already accepted admission; normal admission is covered above.
    await owner.query(
      "UPDATE berth_executor.admission SET admitted=true WHERE operation=$1",
      [operation],
    );
    const ports = {
      database: () =>
        new Client({
          host: "127.0.0.1",
          port,
          database: "neondb",
          user: "berth_runtime",
          password: "test-runtime-only",
        }),
      sdk: () => cloud,
      fetch: async () => {
        throw Error("No external requests in this test");
      },
    };
    assert.deepEqual(await executeLive(e, "scheduled", "delivery", ports), {
      phase: "observe",
    });
    const before = JSON.stringify(cloud);
    assert.deepEqual(await executeLive(e, "scheduled", "delivery", ports), {
      phase: "duplicate",
    });
    assert.equal(JSON.stringify(cloud), before);
    const report = (
      await owner.query("SELECT berth_executor.report($1) AS result", [
        operation,
      ])
    ).rows[0].result;
    assert.equal(report.phase, "observe");
    assert.ok(report.receipt);
    await owner.query(
      "UPDATE berth_ledger.trials SET neon_used=neon_limit-12 WHERE operation=$1",
      [operation],
    );
    assert.deepEqual(
      await executeLive(e, "scheduled", "exhausted-normal-budget", ports),
      { phase: "needs-reconciliation" },
    );
    assert.deepEqual(
      await executeLive(e, "scheduled", "autonomous-recovery", ports),
      { phase: "terminal" },
    );
    assert.equal(cloud.object, undefined);
    assert.equal(cloud.value, undefined);
    const terminal = (
      await owner.query("SELECT berth_executor.report($1) AS result", [
        operation,
      ])
    ).rows[0].result;
    assert.equal(terminal.trial.outcome, "failed");
    assert.equal(terminal.cleanup_requested, true);
    assert.ok(terminal.trial.cleanup_used <= 40);
  } finally {
    for (const schema of ["berth_usage", "berth_executor", "berth_ledger"])
      await owner.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await owner.end();
  }
});

/** Fresh SQL fixture for the three CLI-review regressions; no provider network calls. */
async function reviewedAdmission(
  work: (
    owner: Client,
    db: Client,
    operation: string,
    binding: Record<string, unknown>,
  ) => Promise<void>,
) {
  const port = Number(process.env.BERTH_TEST_POSTGRES_PORT);
  assert.ok(port > 0 && port < 65536);
  const owner = new Client({
    host: "127.0.0.1",
    port,
    database: "neondb",
    user: "neondb_owner",
    password: "berth-test-only",
  });
  const db = new Client({
    host: "127.0.0.1",
    port,
    database: "neondb",
    user: "berth_runtime",
    password: "test-runtime-only",
  });
  await owner.connect();
  await db.connect();
  try {
    for (const name of [
      "001_trial",
      "002_executor",
      "003_usage",
      "004_admission",
    ])
      await owner.query(await readFile(`migrations/${name}.sql`, "utf8"));
    const operation = randomUUID(),
      binding = {
        compartment: "ocid1.compartment.oc1..fixture",
        namespace: "fixture",
        region: "eu-frankfurt-1",
        monitoringLimit: 20,
        neonLimit: 40,
        tenancy: "ocid1.tenancy.oc1..fixture",
        user: "ocid1.user.oc1..fixture",
        fingerprint: "fixture",
      };
    await owner.query(
      "SELECT berth_executor.prepare($1,clock_timestamp()-interval '1 second',$2,$3)",
      [
        operation,
        JSON.stringify(binding),
        JSON.stringify({
          iamReviewed: true,
          iamCheckedAt: Date.now(),
          checkedAt: Date.now(),
        }),
      ],
    );
    await owner.query(
      "UPDATE berth_executor.admission SET admitted=true,verified_at=clock_timestamp() WHERE operation=$1",
      [operation],
    );
    await work(owner, db, operation, binding);
  } finally {
    await db.end();
    for (const schema of ["berth_usage", "berth_executor", "berth_ledger"])
      await owner.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await owner.end();
  }
}

test("cleanup control cannot drain executor reserve and cancellation commits with its charge", async () => {
  await reviewedAdmission(async (owner, db, operation, binding) => {
    await owner.query(
      "UPDATE berth_ledger.trials SET neon_used=neon_limit-12 WHERE operation=$1",
      [operation],
    );
    const cancel = () =>
      db.query("SELECT berth_executor.meter_http($1,$2,$3,'cleanup')", [
        operation,
        JSON.stringify(binding),
        randomUUID(),
      ]);
    await cancel();
    const cancelled = (
      await owner.query(
        "SELECT cleanup_requested FROM berth_executor.work WHERE operation=$1",
        [operation],
      )
    ).rows[0]?.cleanup_requested;
    const repeats = [];
    for (let i = 0; i < 12; i++)
      repeats.push(
        await cancel().then(
          () => true,
          () => false,
        ),
      );
    assert.equal(
      (
        await owner.query(
          "SELECT neon_used FROM berth_ledger.trials WHERE operation=$1",
          [operation],
        )
      ).rows[0].neon_used,
      29,
      "repeated HTTP calls must leave eleven units for execution",
    );
    assert.ok(repeats.every((accepted) => !accepted));
    assert.equal(
      cancelled,
      true,
      "cancellation must commit atomically with metering",
    );
    const ledger = makeLedger(db),
      claim = await ledger.claim(operation, randomUUID());
    const invocation = await ledger.begin(claim, randomUUID(), "invoke");
    assert.equal(
      (await ledger.reserve(claim, invocation, randomUUID())).fresh,
      true,
    );
    assert.equal(
      (
        await owner.query(
          "SELECT neon_used FROM berth_ledger.trials WHERE operation=$1",
          [operation],
        )
      ).rows[0].neon_used,
      30,
    );
  });
});

test("admission requires both attestations to remain fresh through creation cutoff", async () => {
  await reviewedAdmission(async (owner, db, operation, binding) => {
    await owner.query(
      "UPDATE berth_executor.admission SET admitted=false WHERE operation=$1",
      [operation],
    );
    for (const field of ["checkedAt", "iamCheckedAt"]) {
      const evidence = {
        iamReviewed: true,
        checkedAt: Date.now(),
        iamCheckedAt: Date.now(),
        [field]: Date.now() - 86340000,
      };
      await owner.query(
        "UPDATE berth_executor.admission SET evidence=$2 WHERE operation=$1",
        [operation, JSON.stringify(evidence)],
      );
      await assert.rejects(
        db.query("SELECT berth_executor.admit($1,$2)", [
          operation,
          JSON.stringify(binding),
        ]),
        /Admission evidence/,
      );
    }
    await owner.query(
      "UPDATE berth_executor.admission SET evidence=$2 WHERE operation=$1",
      [
        operation,
        JSON.stringify({
          iamReviewed: true,
          checkedAt: Date.now(),
          iamCheckedAt: Date.now(),
        }),
      ],
    );
    assert.equal(
      (
        await db.query("SELECT berth_executor.admit($1,$2) AS fresh", [
          operation,
          JSON.stringify(binding),
        ])
      ).rows[0].fresh,
      true,
    );
  });
});

test("failure and creation cutoff admit protected invocation only into durable cleanup", async () => {
  for (const scenario of ["failed", "cutoff"]) {
    await reviewedAdmission(async (owner, db, operation) => {
      await owner.query(
        "UPDATE berth_ledger.trials SET neon_used=neon_limit-12 WHERE operation=$1",
        [operation],
      );
      await owner.query(
        "INSERT INTO berth_executor.work(operation,phase,failed) VALUES($1,$2,$3)",
        [
          operation,
          scenario === "failed" ? "cleanup" : "object",
          scenario === "failed",
        ],
      );
      if (scenario === "cutoff")
        await owner.query(
          "UPDATE berth_ledger.trials SET started_at=clock_timestamp()-interval '31 minutes',expires_at=clock_timestamp()+interval '209 minutes' WHERE operation=$1",
          [operation],
        );
      const ledger = makeLedger(db),
        claim = await ledger.claim(operation, randomUUID());
      const invocation = await ledger.begin(claim, randomUUID(), "invoke");
      assert.equal(
        (await ledger.reserve(claim, invocation, randomUUID())).fresh,
        true,
      );
      assert.equal(
        (
          await owner.query(
            "SELECT cleanup_requested FROM berth_executor.work WHERE operation=$1",
            [operation],
          )
        ).rows[0].cleanup_requested,
        true,
      );
      await assert.rejects(ledger.begin(claim, randomUUID(), "put_object"));
    });
  }
});
