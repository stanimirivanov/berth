import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Client } from "pg";
import { makeLedger } from "../../src/trial/ledger.ts";
import { freePolicyFixture } from "../fakes/free-policy.ts";

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
      "005_functions_exception",
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
      "../../src/trial/live-admission.ts"
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
      "../../src/trial/live-admission.ts"
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
      "../../src/trial/live-admission.ts"
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
      "005_functions_exception",
    ])
      await owner.query(await readFile(`migrations/${name}.sql`, "utf8"));
    const { FakeObjects } = await import("../fakes/oci.ts"),
      { executeLive } = await import("../../src/trial/live-runtime.ts");
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
      JSON.stringify({
        checkedAt: Date.now(),
        iamCheckedAt: Date.now(),
        iamReviewed: true,
        accountType: "always-free",
        homeRegion: binding.region,
        neonFree: true,
        storageBytes: 10485760,
        objectRequests: 200,
        transferBytes: 1048576,
        monitoringRequests: 20,
        neonInvocations: 64,
        measuredComputeSeconds: 60,
        neonComputeSeconds: 60,
      }),
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
  legacy = false,
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
      ...(!legacy ? ["005_functions_exception"] : []),
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
    const serviceEvidence = {
      accountType: "always-free",
      homeRegion: binding.region,
      neonFree: true,
      storageBytes: 10485760,
      objectRequests: 200,
      transferBytes: 1048576,
      monitoringRequests: 20,
      neonInvocations: 40,
      measuredComputeSeconds: 60,
      neonComputeSeconds: 60,
    };
    for (const field of ["checkedAt", "iamCheckedAt"]) {
      const evidence = {
        ...serviceEvidence,
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
          ...serviceEvidence,
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

test("Free exception is owner-prepared once, preserves gates and durably reports partial after success", async () => {
  await reviewedAdmission(async (owner, db, _prior, original) => {
    await owner.query(
      "UPDATE berth_ledger.trials SET outcome='failed' WHERE operation=$1",
      [_prior],
    );
    const operation = randomUUID(),
      startedAt = Date.now() - 1000,
      expiresAt = startedAt + 14400000;
    const binding: Record<string, unknown> & { neonLimit: number } = {
      ...original,
      neonLimit: 64,
    };
    const evidence = {
      checkedAt: Date.now(),
      iamCheckedAt: Date.now(),
      iamReviewed: true,
      accountType: "always-free",
      homeRegion: original.region,
      neonFree: true,
      storageBytes: 10485760,
      objectRequests: 200,
      transferBytes: 1048576,
      monitoringRequests: 20,
      functionsMode: "free-functions-one-trial",
      functionsException: {
        operation,
        startedAt,
        expiresAt,
        unknownAllowanceAccepted: true,
        partialVerdictAccepted: true,
        exclusiveProjectUse: true,
        manualRecoveryReady: true,
        otherServicesEvidence: "review-2026-11-15",
        shutdownBy: expiresAt + 900000,
        probeClientMs: 2252,
        scenario: "64x60-plus36x60-v1",
      },
    };
    const args = [
      operation,
      new Date(startedAt).toISOString(),
      JSON.stringify(binding),
      JSON.stringify(evidence),
    ];
    await assert.rejects(
      db.query("SELECT berth_executor.prepare($1,$2,$3,$4)", args),
    );
    for (const change of [
      { neonInvocations: 1000 },
      { neonComputeSeconds: 6000 },
      { measuredComputeSeconds: 6000 },
      { storageBytes: 0 },
      { objectRequests: 199 },
      { transferBytes: 0 },
      { monitoringRequests: 0 },
      { neonFree: false },
      { accountType: "paid" },
      { iamReviewed: false },
      { checkedAt: Date.now() - 86340000 },
      {
        functionsException: {
          ...evidence.functionsException,
          unknownAllowanceAccepted: false,
        },
      },
      {
        functionsException: {
          ...evidence.functionsException,
          scenario: "invented",
        },
      },
      {
        functionsException: {
          ...evidence.functionsException,
          operation: randomUUID(),
        },
      },
    ])
      await assert.rejects(
        owner.query("SELECT berth_executor.prepare($1,$2,$3,$4)", [
          ...args.slice(0, 3),
          JSON.stringify({ ...evidence, ...change }),
        ]),
      );
    await assert.rejects(
      owner.query("SELECT berth_executor.prepare($1,$2,$3,$4)", [
        operation,
        args[1],
        JSON.stringify({ ...binding, neonLimit: 65 }),
        args[3],
      ]),
    );
    const competingOwner = new Client({
      host: "127.0.0.1",
      port: Number(process.env.BERTH_TEST_POSTGRES_PORT),
      database: "neondb",
      user: "neondb_owner",
      password: "berth-test-only",
    });
    await competingOwner.connect();
    try {
      const races = await Promise.allSettled([
        owner.query("SELECT berth_executor.prepare($1,$2,$3,$4)", args),
        competingOwner.query(
          "SELECT berth_executor.prepare($1,$2,$3,$4)",
          args,
        ),
      ]);
      assert.equal(
        races.filter((result) => result.status === "fulfilled").length,
        1,
      );
      assert.equal(
        (
          await owner.query(
            "SELECT count(*) FROM berth_executor.functions_exception",
          )
        ).rows[0].count,
        "1",
      );
    } finally {
      await competingOwner.end();
    }

    await assert.rejects(
      owner.query("SELECT berth_executor.prepare($1,$2,$3,$4)", args),
    );
    const second = randomUUID();
    await assert.rejects(
      owner.query("SELECT berth_executor.prepare($1,$2,$3,$4)", [
        second,
        args[1],
        args[2],
        JSON.stringify({
          ...evidence,
          functionsException: {
            ...evidence.functionsException,
            operation: second,
          },
        }),
      ]),
    );
    await assert.rejects(
      db.query("DELETE FROM berth_executor.functions_exception"),
    );
    await assert.rejects(
      db.query("UPDATE berth_executor.admission SET evidence='{}'"),
    );
    await assert.rejects(
      db.query(
        "SELECT berth_executor.prepare_without_exception($1,$2,$3,$4)",
        args,
      ),
    );
    await owner.query(
      "UPDATE berth_executor.admission SET verified_at=clock_timestamp() WHERE operation=$1",
      [operation],
    );
    for (const change of [
      { storageBytes: 0 },
      { neonFree: false },
      { objectRequests: 0 },
      { functionsMode: "verified" },
    ]) {
      await owner.query(
        "UPDATE berth_executor.admission SET evidence=$2 WHERE operation=$1",
        [operation, JSON.stringify({ ...evidence, ...change })],
      );
      await assert.rejects(
        db.query("SELECT berth_executor.admit($1,$2)", [operation, args[2]]),
      );
    }
    await owner.query(
      "UPDATE berth_executor.admission SET evidence=$2 WHERE operation=$1",
      [operation, args[3]],
    );
    const environment = {
      compartment: String(original.compartment),
      namespace: String(original.namespace),
      region: String(original.region),
      tenancy: String(original.tenancy),
      user: String(original.user),
      fingerprint: String(original.fingerprint),
      monitoringLimit: 20,
      neonLimit: 64,
      operation,
      startedAt,
      expiresAt,
      token: "a".repeat(40),
      previewKey: "b".repeat(40),
      connection: "unused",
      privateKey: "unused",
    };
    const { liveAdmissionApi } = await import(
      "../../src/trial/live-admission.ts"
    );
    const api = liveAdmissionApi(db, environment, async () => {
      throw Error("Cached receipt should avoid provider work");
    });
    const call = (route: string, body: unknown) =>
      api.fetch(
        new Request(`https://fixture/${route}`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${environment.token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        }),
      );
    const {
      functionsMode: _mode,
      functionsException: _exception,
      ...normalFields
    } = evidence;
    await owner.query(
      "UPDATE berth_executor.admission SET evidence=$2 WHERE operation=$1",
      [
        operation,
        JSON.stringify({
          ...normalFields,
          neonInvocations: 64,
          neonComputeSeconds: 6000,
          measuredComputeSeconds: 6000,
        }),
      ],
    );
    assert.equal(
      (await call("preview", {})).status,
      409,
      "durable exception cannot disappear from preview when owner evidence changes",
    );
    await owner.query(
      "UPDATE berth_executor.admission SET evidence=$2 WHERE operation=$1",
      [operation, JSON.stringify(evidence)],
    );
    const preview = await call("preview", {});
    assert.equal(preview.status, 200);
    const previewBody = await preview.json();
    assert.equal(previewBody.feasibility.verdict, "partial");
    const submit = await call("submit", { preview: previewBody.preview });
    assert.equal(submit.status, 202);
    assert.equal((await submit.json()).feasibility.verdict, "partial");
    assert.equal(
      (
        await db.query("SELECT berth_executor.admit($1,$2) AS admitted", [
          operation,
          args[2],
        ])
      ).rows[0].admitted,
      false,
    );
    const guardedLedger = makeLedger(db),
      guardedClaim = await guardedLedger.claim(operation, randomUUID());
    const pendingCreate = await guardedLedger.begin(
      guardedClaim,
      randomUUID(),
      "create_bucket",
    );
    await owner.query(
      "UPDATE berth_executor.admission SET evidence=$2 WHERE operation=$1",
      [
        operation,
        JSON.stringify({
          ...evidence,
          functionsException: {
            ...evidence.functionsException,
            partialVerdictAccepted: false,
          },
        }),
      ],
    );
    await assert.rejects(
      guardedLedger.begin(guardedClaim, randomUUID(), "put_object"),
    );
    await assert.rejects(
      guardedLedger.reserve(guardedClaim, pendingCreate, randomUUID()),
    );
    await owner.query(
      "UPDATE berth_executor.admission SET evidence=$2 WHERE operation=$1",
      [operation, JSON.stringify(evidence)],
    );
    await guardedLedger.release(guardedClaim);
    await owner.query(
      "UPDATE berth_ledger.trials SET outcome='succeeded' WHERE operation=$1",
      [operation],
    );
    const report = (
      await db.query("SELECT berth_executor.report($1) AS result", [operation])
    ).rows[0].result;
    assert.equal(report.trial.outcome, "succeeded");
    assert.equal(report.feasibility.verdict, "partial");
    assert.equal(report.feasibility.functionsAllowance, "unknown");
    assert.equal(report.feasibility.hardSpendingCap, false);
    const { executeLive } = await import("../../src/trial/live-runtime.ts");
    const live = await executeLive(environment, "evidence", undefined, {
      database: () => ({
        connect: async () => {},
        end: async () => {},
        query: (text, values) => db.query(text, values ? [...values] : []),
      }),
    });
    assert.deepEqual(
      (live as { feasibility: unknown }).feasibility,
      report.feasibility,
    );

    await assert.rejects(
      owner.query("SELECT berth_executor.prepare($1,$2,$3,$4)", [
        second,
        args[1],
        args[2],
        JSON.stringify({
          ...evidence,
          functionsException: {
            ...evidence.functionsException,
            operation: second,
          },
        }),
      ]),
    );
    // An expired or inconsistent window never blocks owner evidence reads or renews cloud work.
    const expiredAt = Date.now() - 1000;
    for (const outcome of ["succeeded", "needs-reconciliation"]) {
      await owner.query(
        "UPDATE berth_ledger.trials SET started_at=$2,expires_at=$3,outcome=$4 WHERE operation=$1",
        [
          operation,
          new Date(expiredAt - 14400000),
          new Date(expiredAt),
          outcome,
        ],
      );
      const retained = (
        await owner.query("SELECT berth_executor.report($1) AS result", [
          operation,
        ])
      ).rows[0].result;
      assert.equal(retained.trial.outcome, outcome);
      assert.ok(Date.parse(retained.trial.expires_at) < Date.now());
      assert.equal(retained.feasibility.verdict, "partial");
      assert.deepEqual(
        await executeLive(
          {
            ...environment,
            startedAt: expiredAt - 14400000,
            expiresAt: expiredAt,
          },
          "evidence",
          undefined,
          {
            database: () => {
              throw Error("Expired hosted requests must not connect");
            },
          },
        ),
        { phase: "expired" },
      );
    }
  });
});

test("direct normal SQL admission rejects unknown and insufficient service headroom", async () => {
  await reviewedAdmission(async (owner, db, operation, binding) => {
    await owner.query(
      "UPDATE berth_executor.admission SET admitted=false WHERE operation=$1",
      [operation],
    );
    const valid = {
      checkedAt: Date.now(),
      iamCheckedAt: Date.now(),
      iamReviewed: true,
      accountType: "always-free",
      homeRegion: binding.region,
      neonFree: true,
      storageBytes: 10485760,
      objectRequests: 200,
      transferBytes: 1048576,
      monitoringRequests: 20,
      neonInvocations: 40,
      measuredComputeSeconds: 60,
      neonComputeSeconds: 60,
    };
    for (const patch of [
      { neonInvocations: null },
      { neonInvocations: 39 },
      { neonComputeSeconds: 59 },
      { measuredComputeSeconds: 0 },
      { storageBytes: 0 },
      { objectRequests: 199 },
      { transferBytes: 0 },
      { monitoringRequests: 19 },
      { neonFree: false },
      { accountType: "paid" },
      { homeRegion: "wrong" },
      { neonComputeSeconds: "Infinity" },
    ]) {
      await owner.query(
        "UPDATE berth_executor.admission SET evidence=$2 WHERE operation=$1",
        [operation, JSON.stringify({ ...valid, ...patch })],
      );
      assert.equal(
        (
          await db.query(
            "SELECT berth_executor.admission_status($1,$2) AS status",
            [operation, JSON.stringify(binding)],
          )
        ).rows[0].status.evidenceBound,
        false,
      );
      await assert.rejects(
        db.query("SELECT berth_executor.admit($1,$2)", [
          operation,
          JSON.stringify(binding),
        ]),
      );
    }
    await owner.query(
      "UPDATE berth_executor.admission SET evidence=$2 WHERE operation=$1",
      [operation, JSON.stringify(valid)],
    );
    assert.equal(
      (
        await db.query("SELECT berth_executor.admit($1,$2) AS accepted", [
          operation,
          JSON.stringify(binding),
        ])
      ).rows[0].accepted,
      true,
    );
  });
});

test("legacy direct SQL admission cannot create via schedule but retains owned cleanup and partial evidence", async () => {
  for (const owned of [false, true]) {
    await reviewedAdmission(async (owner, db, operation, binding) => {
      await owner.query(
        'UPDATE berth_executor.admission SET admitted=false,evidence=evidence || \'{"functionsMode":"free-functions-one-trial"}\'::jsonb WHERE operation=$1',
        [operation],
      );
      assert.equal(
        (
          await db.query("SELECT berth_executor.admit($1,$2) AS admitted", [
            operation,
            JSON.stringify(binding),
          ])
        ).rows[0].admitted,
        true,
      );
      const trial = (
        await db.query("SELECT berth_executor.report($1) AS result", [
          operation,
        ])
      ).rows[0].result.trial;
      const environment = {
        compartment: String(binding.compartment),
        namespace: String(binding.namespace),
        region: String(binding.region),
        tenancy: String(binding.tenancy),
        user: String(binding.user),
        fingerprint: String(binding.fingerprint),
        monitoringLimit: 20,
        neonLimit: 40,
        operation,
        startedAt: Date.parse(trial.started_at),
        expiresAt: Date.parse(trial.expires_at),
        token: "a".repeat(40),
        previewKey: "b".repeat(40),
        connection: "unused",
        privateKey: generateKeyPairSync("rsa", { modulusLength: 2048 })
          .privateKey.export({ type: "pkcs8", format: "pem" })
          .toString(),
      };
      const { executeLive } = await import("../../src/trial/live-runtime.ts");
      const { FakeObjects } = await import("../fakes/oci.ts");
      const cloud = new FakeObjects();
      const ports = {
        database: () => ({
          connect: async () => {},
          end: async () => {},
          query: (text: string, values?: readonly unknown[]) =>
            db.query(text, values ? [...values] : []),
        }),
        sdk: () => cloud,
        fetch: async () => {
          throw Error("No network");
        },
      };
      if (owned) {
        const { runExecutor } = await import("../../src/trial/executor.ts");
        assert.equal(
          (
            await runExecutor(db, {
              operation,
              delivery: "a".repeat(64),
              expiresAt: environment.expiresAt,
              sdk: () => cloud,
            })
          ).phase,
          "object",
        );
        assert.ok(cloud.value);
      }
      await executeLive(environment, "scheduled", "legacy-delivery", ports);
      assert.equal(cloud.creates, owned ? 1 : 0);
      assert.equal(cloud.value, undefined);
      assert.equal(cloud.deletes, owned ? 1 : 0);

      assert.equal(
        (
          await owner.query(
            "SELECT count(*) FROM berth_ledger.attempts WHERE operation=$1 AND action IN ('create_bucket','put_object')",
            [operation],
          )
        ).rows[0].count,
        owned ? "1" : "0",
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
      const evidence = await executeLive(
        environment,
        "evidence",
        undefined,
        ports,
      );
      assert.equal(
        (evidence as { feasibility: { verdict: string } }).feasibility.verdict,
        "partial",
      );
      assert.equal(
        (
          (await executeLive(environment, "cleanup", undefined, ports)) as {
            status: string;
          }
        ).status,
        "cleanup-requested",
      );
    }, true);
  }
});

test("Free policy rejects fabricated quotas and stale plan evidence without blocking unknown Functions totals", async () => {
  const { preflight, functionsAssessment } = await import(
    "../../src/trial/preflight.ts"
  );
  const operation = randomUUID(),
    startedAt = Date.now() - 1000;
  const configuration = {
    compartment: "ocid1.compartment.oc1..fixture",
    namespace: "fixture",
    region: "eu-frankfurt-1",
    monitoringLimit: 20,
    neonLimit: 64,
  };
  const prepared = { operation, startedAt, expiresAt: startedAt + 14400000 };
  const evidence = freePolicyFixture(
    operation,
    startedAt,
    configuration.region,
  );
  assert.deepEqual(
    preflight(configuration, evidence, Date.now(), prepared),
    [],
  );
  assert.equal(functionsAssessment(evidence)?.verdict, "partial");
  assert.deepEqual(
    preflight(
      configuration,
      {
        ...evidence,
        functionsPolicy: {
          ...evidence.functionsPolicy,
          plan: { ...evidence.functionsPolicy.plan, source: "provider-api" },
        },
      },
      Date.now(),
      prepared,
    ),
    [],
  );
  for (const patch of [
    { functionsPolicy: { ...evidence.functionsPolicy, plan: null } },
    {
      functionsPolicy: {
        ...evidence.functionsPolicy,
        plan: { ...evidence.functionsPolicy.plan, status: "unknown" },
      },
    },
    { functionsUsage: 0 },
    { functionsAllowance: 100 },
    { neonInvocations: 64 },
    { functionsException: {} },
    { functionsMode: "invented" },
    {
      functionsPolicy: {
        ...evidence.functionsPolicy,
        manualRecoveryReady: false,
      },
    },
    {
      functionsPolicy: { ...evidence.functionsPolicy, operation: randomUUID() },
    },
    {
      functionsPolicy: {
        ...evidence.functionsPolicy,
        plan: { ...evidence.functionsPolicy.plan, status: "paid" },
      },
    },
    {
      functionsPolicy: {
        ...evidence.functionsPolicy,
        plan: { ...evidence.functionsPolicy.plan, source: "client" },
      },
    },
    {
      functionsPolicy: {
        ...evidence.functionsPolicy,
        plan: {
          ...evidence.functionsPolicy.plan,
          checkedAt: startedAt - 86400000,
        },
      },
    },
    {
      functionsPolicy: {
        ...evidence.functionsPolicy,
        billing: {
          ...evidence.functionsPolicy.billing,
          reviewedAt: Date.now() + 60000,
        },
      },
    },
    {
      functionsPolicy: {
        ...evidence.functionsPolicy,
        allowances: {
          ...evidence.functionsPolicy.allowances,
          sharedTransferBytes: 0,
        },
      },
    },
    {
      functionsPolicy: {
        ...evidence.functionsPolicy,
        allowances: {
          ...evidence.functionsPolicy.allowances,
          requiredPostgresComputeCuSeconds: 1,
        },
      },
    },
  ])
    assert.ok(
      preflight(configuration, { ...evidence, ...patch }, Date.now(), prepared)
        .length,
    );
});

test("Free policy binds owner SQL authorization, rejects replay and preserves spent cleanup and historical evidence", async () => {
  await reviewedAdmission(async (owner, db, prior, original) => {
    await owner.query(
      "UPDATE berth_ledger.trials SET outcome='failed' WHERE operation=$1",
      [prior],
    );
    // Retain a consumed historical slot; the new operation must not reuse or rewrite it.
    await owner.query(
      `INSERT INTO berth_executor.functions_exception(operation,started_at,expires_at,binding,evidence)
      SELECT operation,started_at,expires_at,binding,evidence FROM berth_executor.admission JOIN berth_ledger.trials USING(operation) WHERE operation=$1`,
      [prior],
    );
    const historical = (
      await owner.query(
        "SELECT to_jsonb(x) AS value FROM berth_executor.functions_exception x",
      )
    ).rows[0].value;
    await owner.query(
      await readFile("migrations/006_free_functions_policy.sql", "utf8"),
    );
    const operation = randomUUID(),
      startedAt = Date.now() - 1000;
    const binding: Record<string, unknown> & { neonLimit: number } = {
      ...original,
      neonLimit: 64,
    };
    const evidence = freePolicyFixture(operation, startedAt, original.region);
    const args = [
      operation,
      new Date(startedAt),
      JSON.stringify(binding),
      JSON.stringify(evidence),
    ];
    await assert.rejects(
      db.query("SELECT berth_executor.prepare($1,$2,$3,$4)", args),
    );
    for (const changed of [
      { ...evidence, functionsMode: "free-functions-one-trial" },
      { ...evidence, neonComputeSeconds: 6000 },
      { ...evidence, iamReviewed: false },
      {
        ...evidence,
        functionsPolicy: {
          ...evidence.functionsPolicy,
          manualRecoveryReady: false,
        },
      },
      {
        ...evidence,
        functionsPolicy: {
          ...evidence.functionsPolicy,
          plan: { ...evidence.functionsPolicy.plan, status: "paid" },
        },
      },
      {
        ...evidence,
        functionsPolicy: {
          ...evidence.functionsPolicy,
          plan: {
            ...evidence.functionsPolicy.plan,
            checkedAt: startedAt - 86400000,
          },
        },
      },
      {
        ...evidence,
        functionsPolicy: {
          ...evidence.functionsPolicy,
          billing: { ...evidence.functionsPolicy.billing, source: "no-card" },
        },
      },
      {
        ...evidence,
        functionsPolicy: {
          ...evidence.functionsPolicy,
          allowances: {
            ...evidence.functionsPolicy.allowances,
            postgresStorageBytes: 0,
          },
        },
      },
      {
        ...evidence,
        functionsPolicy: {
          ...evidence.functionsPolicy,
          allowances: {
            ...evidence.functionsPolicy.allowances,
            requiredPostgresComputeCuSeconds: 1,
          },
        },
      },
    ])
      await assert.rejects(
        owner.query("SELECT berth_executor.prepare($1,$2,$3,$4)", [
          ...args.slice(0, 3),
          JSON.stringify(changed),
        ]),
      );
    await owner.query("SELECT berth_executor.prepare($1,$2,$3,$4)", args);
    await assert.rejects(
      owner.query("SELECT berth_executor.prepare($1,$2,$3,$4)", args),
    );
    await owner.query(
      "UPDATE berth_executor.admission SET verified_at=clock_timestamp() WHERE operation=$1",
      [operation],
    );
    const environment = {
      compartment: String(binding.compartment),
      namespace: String(binding.namespace),
      region: String(binding.region),
      tenancy: String(binding.tenancy),
      user: String(binding.user),
      fingerprint: String(binding.fingerprint),
      monitoringLimit: 20,
      neonLimit: 64,
      operation,
      startedAt,
      expiresAt: startedAt + 14400000,
      token: "a".repeat(40),
      previewKey: "b".repeat(40),
      connection: "unused",
      privateKey: "unused",
    };
    const { liveAdmissionApi } = await import(
      "../../src/trial/live-admission.ts"
    );
    const api = liveAdmissionApi(db, environment, async () => {
      throw Error("Cached receipt only");
    });
    const call = (route: string, body: unknown) =>
      api.fetch(
        new Request(`https://fixture/${route}`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${environment.token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        }),
      );
    assert.equal((await call("preview", { evidence })).status, 400);
    const preview = await call("preview", {});
    assert.equal(preview.status, 200);
    const proposal = await preview.json();
    assert.equal(proposal.feasibility.functionsAllowance, "unknown");
    for (const changed of [
      { ...evidence, functionsUsage: 0 },
      { ...evidence, storageBytes: 0 },
      {
        ...evidence,
        functionsMode: "verified",
        neonInvocations: 64,
        neonComputeSeconds: 6000,
        measuredComputeSeconds: 6000,
      },
      {
        ...evidence,
        functionsPolicy: {
          ...evidence.functionsPolicy,
          plan: { ...evidence.functionsPolicy.plan, status: "paid" },
        },
      },
    ]) {
      await owner.query(
        "UPDATE berth_executor.admission SET evidence=$2 WHERE operation=$1",
        [operation, JSON.stringify(changed)],
      );
      assert.equal(
        (await call("submit", { preview: proposal.preview })).status,
        409,
      );
      await assert.rejects(
        db.query("SELECT berth_executor.admit($1,$2)", [operation, args[2]]),
      );
    }
    await owner.query(
      "UPDATE berth_executor.admission SET evidence=$2 WHERE operation=$1",
      [operation, args[3]],
    );
    assert.equal(
      (await call("submit", { preview: proposal.preview })).status,
      202,
    );
    assert.equal(
      (await call("submit", { preview: proposal.preview })).status,
      202,
    );
    const ledger = makeLedger(db),
      claim = await ledger.claim(operation, randomUUID());
    const attempt = await ledger.begin(claim, randomUUID(), "create_bucket");
    await owner.query(
      "UPDATE berth_executor.admission SET evidence='{}' WHERE operation=$1",
      [operation],
    );
    await assert.rejects(ledger.reserve(claim, attempt, randomUUID()));
    await assert.rejects(ledger.begin(claim, randomUUID(), "put_object"));
    await owner.query(
      "UPDATE berth_ledger.trials SET neon_used=52 WHERE operation=$1",
      [operation],
    );
    const { meterAdmission } = await import(
      "../../src/trial/live-admission.ts"
    );
    await assert.rejects(meterAdmission(db, environment));
    await meterAdmission(db, environment, "cleanup");
    await assert.rejects(meterAdmission(db, environment, "cleanup"));
    assert.equal(
      (
        await owner.query(
          "SELECT neon_used FROM berth_ledger.trials WHERE operation=$1",
          [operation],
        )
      ).rows[0].neon_used,
      53,
    );
    assert.equal((await call("cleanup", { operation })).status, 202);
    const report = (
      await db.query("SELECT berth_executor.report($1) AS value", [operation])
    ).rows[0].value;
    assert.equal(report.feasibility.verdict, "partial");
    assert.equal(report.feasibility.functionsUsage, "unknown");
    assert.equal(report.feasibility.manualRecoveryReady, true);
    assert.equal(report.feasibility.unknownAllowanceAccepted, true);
    assert.equal(report.feasibility.policyVersion, "free-plan-v1");
    await assert.rejects(
      owner.query(
        "UPDATE berth_executor.functions_policy SET evidence='{}' WHERE operation=$1",
        [operation],
      ),
    );
    await assert.rejects(
      owner.query(
        "DELETE FROM berth_executor.functions_policy WHERE operation=$1",
        [operation],
      ),
    );
    assert.equal(report.feasibility.hardSpendingCap, false);
    await assert.rejects(
      db.query("UPDATE berth_executor.functions_policy SET evidence='{}'"),
    );
    await assert.rejects(
      db.query(
        "SELECT berth_executor.prepare_without_exception($1,$2,$3,$4)",
        args,
      ),
    );
    await owner.query(
      "UPDATE berth_ledger.trials SET normal_used=160,cleanup_used=39 WHERE operation=$1",
      [operation],
    );
    const cleanup = await ledger.begin(claim, randomUUID(), "inspect_cleanup");
    const normal = await ledger.begin(claim, randomUUID(), "inspect");
    await assert.rejects(ledger.reserve(claim, normal, randomUUID()));
    await ledger.reserve(claim, cleanup, randomUUID());
    await assert.rejects(ledger.reserve(claim, cleanup, randomUUID()));
    const spent = (
      await owner.query(
        "SELECT normal_used,cleanup_used FROM berth_ledger.trials WHERE operation=$1",
        [operation],
      )
    ).rows[0];
    assert.deepEqual(spent, { normal_used: 160, cleanup_used: 40 });
    await owner.query(
      "UPDATE berth_ledger.trials SET started_at=clock_timestamp()-interval '4 hours 1 second',expires_at=clock_timestamp()-interval '1 second' WHERE operation=$1",
      [operation],
    );
    await assert.rejects(ledger.begin(claim, randomUUID(), "inspect_cleanup"));
    await ledger.release(claim);
    await owner.query(
      "UPDATE berth_ledger.trials SET outcome='succeeded' WHERE operation=$1",
      [operation],
    );
    assert.equal(
      (await db.query("SELECT berth_executor.report($1) AS value", [operation]))
        .rows[0].value.feasibility.verdict,
      "partial",
    );
    assert.deepEqual(
      (
        await owner.query(
          "SELECT to_jsonb(x) AS value FROM berth_executor.functions_exception x",
        )
      ).rows[0].value,
      historical,
    );
  });
});

/** Explicit synthetic issue-76 approval; raw observations are never substituted for remaining quota. */
function boundedAllowanceFixture(
  operation: string,
  start: number,
  region: unknown,
) {
  const {
    objectRequests: _r,
    transferBytes: _t,
    monitoringRequests: _m,
    ...base
  } = freePolicyFixture(operation, start, region);
  const { sharedTransferBytes: _s, ...known } = base.functionsPolicy.allowances;
  const descriptors = [
    ["neonSharedTransfer", 1234567, "bytes", 1048576, "partial"],
    ["ociObjectRequests", 0.01, "10K Requests", 200, "partial"],
    ["ociOutboundTransfer", 0.00002, "GB Months", 1048576, "partial"],
    ["ociMonitoringIngestion", "not-exposed", "not-exposed", 1, "unavailable"],
    ["ociMonitoringRetrieval", 0.1, "Million Datapoints", 100, "partial"],
  ];
  return {
    ...base,
    functionsPolicy: { ...base.functionsPolicy, allowances: known },
    allowanceException: {
      version: "issue76-once-v1",
      issue: 76,
      approvalRef: "offline-explicit-operation-approval",
      unknownActivityAccepted: true,
      quotaFailureAccepted: true,
      ociFree: {
        status: "free-tier",
        source: "owner-console",
        checkedAt: start,
        evidence: "offline-free-status",
        billingEvidence: "offline-free-policy",
        billingReviewedAt: start,
      },
      meters: Object.fromEntries(
        descriptors.map(([key, observed, unit, required, coverage]) => [
          key,
          {
            observed,
            unit,
            required,
            coverage,
            remaining: "unknown",
            knownInsufficient: false,
            sourceRef: "offline-provider-artifact",
            periodRef: "nov-2026",
            checkedAt: start,
          },
        ]),
      ),
    },
  };
}

test("bounded allowance exception accepts only listed unknowns and rejects known insufficient raw or normalized observations", async () => {
  const { preflight, functionsAssessment } = await import(
    "../../src/trial/preflight.ts"
  );
  const operation = randomUUID(),
    startedAt = Date.now() - 1000;
  const c = {
    compartment: "ocid1.compartment.oc1..fixture",
    namespace: "fixture",
    region: "eu-frankfurt-1",
    monitoringLimit: 20,
    neonLimit: 64,
  };
  const p = { operation, startedAt, expiresAt: startedAt + 14400000 };
  const e = boundedAllowanceFixture(operation, startedAt, c.region);
  assert.deepEqual(preflight(c, e, Date.now(), p), []);
  assert.equal(functionsAssessment(e)?.verdict, "partial");
  for (const key of Object.keys(e.allowanceException.meters)) {
    for (const change of [
      { remaining: 0 },
      { required: 0 },
      { required: 100000000000000 },
      {
        remaining: 100000000000000,
        coverage: "complete",
        normalizationRef: "fake",
      },
      { knownInsufficient: true },
      { checkedAt: startedAt - 86400000 },
      { remaining: "0" },
      { coverage: "invented" },
    ]) {
      const v = structuredClone(e);
      Object.assign(v.allowanceException.meters[key], change);
      assert.ok(
        preflight(c, v, Date.now(), p).length,
        `${key}: ${JSON.stringify(change)}`,
      );
    }
  }
  for (const change of [
    { storageBytes: 0 },
    { objectRequests: 199 },
    { transferBytes: 0 },
    { monitoringRequests: 0 },
    { allowanceException: null },
    {
      allowanceException: {
        ...e.allowanceException,
        unknownActivityAccepted: false,
      },
    },
    { allowanceException: { ...e.allowanceException, issue: 75 } },
    {
      allowanceException: {
        ...e.allowanceException,
        meters: {
          ...e.allowanceException.meters,
          extra: e.allowanceException.meters.neonSharedTransfer,
        },
      },
    },
    {
      allowanceException: {
        ...e.allowanceException,
        ociFree: { ...e.allowanceException.ociFree, status: "paid" },
      },
    },
    {
      functionsPolicy: {
        ...e.functionsPolicy,
        allowances: {
          ...e.functionsPolicy.allowances,
          postgresComputeCuSeconds: 1,
        },
      },
    },
  ])
    assert.ok(preflight(c, { ...e, ...change }, Date.now(), p).length);
  for (const [key, observed] of [
    ["neonSharedTransfer", 5000000000],
    ["ociObjectRequests", 5],
    ["ociMonitoringRetrieval", 1000],
  ] as const) {
    const v = structuredClone(e);
    v.allowanceException.meters[key].observed = observed;
    assert.ok(
      preflight(c, v, Date.now(), p).length,
      "partial coverage cannot hide already exhausted usage",
    );
  }
  const complete = structuredClone(e);
  Object.assign(complete.allowanceException.meters.ociObjectRequests, {
    remaining: 49900,
    coverage: "complete",
    normalizationRef: "reviewed-request-conversion",
  });
  assert.deepEqual(preflight(c, complete, Date.now(), p), []);
  complete.allowanceException.meters.ociObjectRequests.remaining = 50000;
  assert.ok(
    preflight(c, complete, Date.now(), p).length,
    "known remaining cannot exceed cap minus observed usage",
  );
  const ambiguous = structuredClone(e);
  Object.assign(ambiguous.allowanceException.meters.ociOutboundTransfer, {
    remaining: 2000000,
    coverage: "complete",
    normalizationRef: "invented",
  });
  assert.ok(
    preflight(c, ambiguous, Date.now(), p).length,
    "ambiguous GB Months never silently becomes bytes",
  );
  const boundary = structuredClone(e);
  Object.assign(boundary.allowanceException.meters.ociObjectRequests, {
    observed: 4.98,
    remaining: 200,
    coverage: "complete",
    normalizationRef: "exact-decimal-conversion",
  });
  assert.deepEqual(
    preflight(c, boundary, Date.now(), p),
    [],
    "decimal 4.98 x 10000 leaves exactly 200 requests",
  );
  const fractionalTime = { ...e, checkedAt: startedAt + 0.5 };
  assert.ok(
    preflight(c, fractionalTime, Date.now(), p).length,
    "exception timestamps agree with integer SQL contract",
  );
  const { allowanceException: _x, ...without } = e;
  assert.ok(
    preflight(c, without, Date.now(), p).length,
    "strict default still requires known allowance",
  );
});

test("issue76 singleton binds exact owner preparation while malformed evidence leaves protected cleanup and historical qualification intact", async () => {
  await reviewedAdmission(async (owner, db, prior, original) => {
    await owner.query(
      "UPDATE berth_ledger.trials SET outcome='failed' WHERE operation=$1",
      [prior],
    );
    await owner.query(
      `INSERT INTO berth_executor.functions_exception(operation,started_at,expires_at,binding,evidence)
      SELECT operation,started_at,expires_at,binding,evidence FROM berth_executor.admission JOIN berth_ledger.trials USING(operation) WHERE operation=$1`,
      [prior],
    );
    const historical = (
      await owner.query(
        "SELECT to_jsonb(x) AS value FROM berth_executor.functions_exception x",
      )
    ).rows[0].value;
    await owner.query(
      await readFile("migrations/006_free_functions_policy.sql", "utf8"),
    );
    await owner.query(
      await readFile("migrations/007_bounded_allowance_exception.sql", "utf8"),
    );
    const operation = randomUUID(),
      startedAt = Date.now() - 1000;
    const binding = { ...original, neonLimit: 64 };
    const evidence = boundedAllowanceFixture(
      operation,
      startedAt,
      original.region,
    );
    const args = [
      operation,
      new Date(startedAt),
      JSON.stringify(binding),
      JSON.stringify(evidence),
    ];
    await assert.rejects(
      db.query("SELECT berth_executor.prepare($1,$2,$3,$4)", args),
    );
    for (const key of Object.keys(evidence.allowanceException.meters)) {
      for (const patch of [
        { remaining: 0 },
        { required: 0 },
        { required: 100000000000000 },
        { knownInsufficient: true },
        { checkedAt: startedAt - 86400000 },
      ]) {
        const invalid = structuredClone(evidence);
        Object.assign(invalid.allowanceException.meters[key], patch);
        await assert.rejects(
          owner.query("SELECT berth_executor.prepare($1,$2,$3,$4)", [
            ...args.slice(0, 3),
            JSON.stringify(invalid),
          ]),
        );
      }
    }
    for (const invalid of [
      { ...evidence, storageBytes: 0 },
      { ...evidence, neonFree: false },
      {
        ...evidence,
        allowanceException: { ...evidence.allowanceException, approvalRef: "" },
      },
      {
        ...evidence,
        allowanceException: {
          ...evidence.allowanceException,
          unknownActivityAccepted: false,
        },
      },
      {
        ...evidence,
        allowanceException: {
          ...evidence.allowanceException,
          quotaFailureAccepted: false,
        },
      },
      {
        ...evidence,
        allowanceException: {
          ...evidence.allowanceException,
          ociFree: { ...evidence.allowanceException.ociFree, status: "paid" },
        },
      },
    ])
      await assert.rejects(
        owner.query("SELECT berth_executor.prepare($1,$2,$3,$4)", [
          ...args.slice(0, 3),
          JSON.stringify(invalid),
        ]),
      );
    await owner.query("SELECT berth_executor.prepare($1,$2,$3,$4)", args);
    await owner.query(
      "UPDATE berth_executor.admission SET verified_at=clock_timestamp() WHERE operation=$1",
      [operation],
    );
    const { liveAdmissionApi } = await import(
      "../../src/trial/live-admission.ts"
    );
    const env = {
      compartment: String(original.compartment),
      namespace: String(original.namespace),
      region: String(original.region),
      tenancy: String(original.tenancy),
      user: String(original.user),
      fingerprint: String(original.fingerprint),
      monitoringLimit: 20,
      neonLimit: 64,
      operation,
      startedAt,
      expiresAt: startedAt + 14400000,
      token: "a".repeat(40),
      previewKey: "b".repeat(40),
      connection: "unused",
      privateKey: "unused",
    };
    const api = liveAdmissionApi(db, env, async () => {
      throw Error("Cached receipt only");
    });
    const call = (route: string, body: unknown) =>
      api.fetch(
        new Request(`https://fixture/${route}`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${env.token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        }),
      );
    assert.equal((await call("preview", { evidence })).status, 400);
    const preview = await call("preview", {});
    assert.equal(preview.status, 200);
    const proposal = await preview.json();
    for (const invalid of [
      null,
      [],
      "bad",
      {
        ...evidence.allowanceException,
        meters: { neonSharedTransfer: { remaining: "bad" } },
      },
    ]) {
      await owner.query(
        "UPDATE berth_executor.admission SET evidence=$2 WHERE operation=$1",
        [
          operation,
          JSON.stringify({ ...evidence, allowanceException: invalid }),
        ],
      );
      assert.equal(
        (await call("submit", { preview: proposal.preview })).status,
        409,
      );
      await assert.rejects(
        db.query("SELECT berth_executor.admit($1,$2)", [operation, args[2]]),
      );
      const status = (
        await db.query(
          "SELECT berth_executor.admission_status($1,$2) AS value",
          [operation, args[2]],
        )
      ).rows[0].value;
      assert.equal(status.evidenceBound, false);
    }
    await owner.query(
      "UPDATE berth_executor.admission SET evidence=$2 WHERE operation=$1",
      [operation, args[3]],
    );
    assert.equal(
      (await call("submit", { preview: proposal.preview })).status,
      202,
    );
    assert.equal(
      (await call("submit", { preview: proposal.preview })).status,
      202,
    );
    const ledger = makeLedger(db),
      claim = await ledger.claim(operation, randomUUID());
    const create = await ledger.begin(claim, randomUUID(), "create_bucket");
    await owner.query(
      "UPDATE berth_executor.admission SET evidence=evidence || '{\"allowanceException\":null}'::jsonb WHERE operation=$1",
      [operation],
    );
    await assert.rejects(ledger.reserve(claim, create, randomUUID()));
    assert.equal((await call("cleanup", { operation })).status, 202);
    await owner.query(
      "UPDATE berth_ledger.trials SET normal_used=160,cleanup_used=39 WHERE operation=$1",
      [operation],
    );
    const cleanup = await ledger.begin(claim, randomUUID(), "inspect_cleanup");
    await ledger.reserve(claim, cleanup, randomUUID());
    await assert.rejects(ledger.reserve(claim, cleanup, randomUUID()));
    await ledger.release(claim);
    await owner.query(
      "UPDATE berth_ledger.trials SET outcome='failed' WHERE operation=$1",
      [operation],
    );
    const report = (
      await db.query("SELECT berth_executor.report($1) AS value", [operation])
    ).rows[0].value;
    assert.equal(report.feasibility.verdict, "partial");
    assert.deepEqual(
      report.feasibility.allowanceException,
      evidence.allowanceException,
    );
    await owner.query(
      "UPDATE berth_ledger.trials SET outcome='succeeded' WHERE operation=$1",
      [operation],
    );
    assert.equal(
      (await db.query("SELECT berth_executor.report($1) AS value", [operation]))
        .rows[0].value.feasibility.verdict,
      "partial",
    );
    assert.deepEqual(
      (
        await owner.query(
          "SELECT to_jsonb(x) AS value FROM berth_executor.functions_exception x",
        )
      ).rows[0].value,
      historical,
    );

    for (const command of [
      "DELETE FROM berth_executor.bounded_allowance_exception",
      "UPDATE berth_executor.bounded_allowance_exception SET evidence='{}'",
    ])
      await assert.rejects(owner.query(command));
    const second = randomUUID();
    const secondEvidence = boundedAllowanceFixture(
      second,
      startedAt,
      original.region,
    );
    await assert.rejects(
      owner.query("SELECT berth_executor.prepare($1,$2,$3,$4)", [
        second,
        args[1],
        args[2],
        JSON.stringify(secondEvidence),
      ]),
    );
    assert.equal(
      (
        await owner.query(
          "SELECT count(*) FROM berth_ledger.trials WHERE operation=$1",
          [second],
        )
      ).rows[0].count,
      "0",
      "second preparation rolls back atomically",
    );
    await assert.rejects(
      db.query(
        "SELECT berth_executor.prepare_without_allowance_exception($1,$2,$3,$4)",
        args,
      ),
    );
    const strict = freePolicyFixture(second, startedAt, original.region);
    await owner.query("SELECT berth_executor.prepare($1,$2,$3,$4)", [
      second,
      args[1],
      args[2],
      JSON.stringify(strict),
    ]);
    assert.equal(
      (
        await db.query(
          "SELECT berth_executor.admission_status($1,$2) AS value",
          [second, args[2]],
        )
      ).rows[0].value.evidenceBound,
      true,
      "strict complete evidence remains supported after consuming the exception",
    );
    assert.equal(
      (
        await owner.query(
          "SELECT count(*) FROM berth_executor.bounded_allowance_exception",
        )
      ).rows[0].count,
      "1",
    );
  });
});

test("read-only operation history paginates retained evidence without exposing raw state or changing budgets", async () => {
  await reviewedAdmission(async (owner, db, operation) => {
    await owner.query(
      await readFile("migrations/008_operation_history.sql", "utf8"),
    );
    const { historyReader } = await import(
      "../../src/application/retained-trial-ledger/history.ts"
    );
    const url =
      "postgresql://berth_runtime:fixture@ep-fixture.neon.tech/neondb";
    const historyTransactionModes: unknown[] = [];
    const store = historyReader(
      { DATABASE_URL: url, DATABASE_URL_UNPOOLED: url },
      () => {
        const connection = new Client({
          host: "127.0.0.1",
          port: Number(process.env.BERTH_TEST_POSTGRES_PORT),
          database: "neondb",
          user: "berth_runtime",
          password: "test-runtime-only",
        });
        return {
          connect: () => connection.connect(),
          end: () => connection.end(),
          async query(text, values) {
            if (
              /^\s*SELECT\s+berth_executor\.history_(?:page|detail)\s*\(/i.test(
                text,
              )
            ) {
              const mode = await connection.query("SHOW transaction_read_only");
              historyTransactionModes.push(mode.rows[0]?.transaction_read_only);
            }
            return connection.query(text, values);
          },
        };
      },
    );
    const empty = await store.list();
    assert.equal(empty.items.length, 1);
    assert.equal(
      empty.items[0]?.phase,
      null,
      "no work row must not invent a phase",
    );
    const ids = [
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
      "33333333-3333-4333-8333-333333333333",
    ];
    await owner.query(
      "UPDATE berth_ledger.trials SET outcome='failed',started_at='2020-01-01Z',expires_at='2020-01-01T04:00:00Z' WHERE operation=$1",
      [operation],
    );
    for (const [i, id] of ids.entries()) {
      await owner.query(
        `INSERT INTO berth_ledger.trials(operation,compartment,region,namespace,digest,bucket,started_at,expires_at,outcome,normal_used,cleanup_used,monitoring_limit,neon_limit)
        VALUES($1,'private-compartment','private-region','private-namespace',repeat('a',64),'private-bucket','2021-01-01Z','2021-01-01T04:00:00Z',$2,15,14,20,40)`,
        [id, ["failed", "succeeded", "needs-reconciliation"][i]],
      );
    }
    await owner.query(
      `INSERT INTO berth_executor.work(operation,phase,pending_upload,cleanup_requested,reason,state,bucket,receipt)
      VALUES($1,'cleanup',true,true,'private-reason','{"private":"state"}','{"private":"bucket"}','{"private":"receipt"}')`,
      [ids[2]],
    );
    const attempt = randomUUID();
    await owner.query(
      "INSERT INTO berth_ledger.attempts(id,operation,action,generation,ordinal) VALUES($1,$2,'put_object',1,1)",
      [attempt, ids[2]],
    );
    await owner.query(
      "INSERT INTO berth_ledger.requests(id,attempt,operation,generation,meter,mutation) VALUES($1,$2,$3,1,'normal',true)",
      [randomUUID(), attempt, ids[2]],
    );
    const snapshot = async () =>
      (
        await owner.query(`SELECT jsonb_build_object(
      'trials',(SELECT jsonb_agg(to_jsonb(t) ORDER BY operation) FROM berth_ledger.trials t),
      'work',(SELECT jsonb_agg(to_jsonb(t) ORDER BY operation) FROM berth_executor.work t),
      'attempts',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM berth_ledger.attempts t),
      'requests',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM berth_ledger.requests t),
      'claims',(SELECT jsonb_agg(to_jsonb(t) ORDER BY owner) FROM berth_ledger.claims t),
      'admission',(SELECT jsonb_agg(to_jsonb(t) ORDER BY operation) FROM berth_executor.admission t)
    ) AS evidence`)
      ).rows[0].evidence;
    const before = await snapshot();
    const first = await store.list(null, 2);
    assert.deepEqual(
      first.items.map((item) => item.operation),
      [ids[2], ids[1]],
    );
    assert.equal(first.next, ids[1]);
    const second = await store.list(first.next, 2);
    assert.deepEqual(
      second.items.map((item) => item.operation),
      [ids[0], operation],
    );
    assert.equal(second.next, null);
    assert.deepEqual(await store.list(operation), {
      items: [],
      next: null,
    });
    const detail = await store.detail(ids[2] as string);
    assert.ok(detail);
    assert.equal(detail.outcome, "needs-reconciliation");
    assert.equal(detail.phase, "cleanup");
    assert.equal(detail.pendingUpload, true);
    assert.equal(detail.cleanupRequested, true);
    assert.equal(detail.verdict, "partial");
    assert.deepEqual(detail.budgets, {
      normal: { used: 15, limit: 160 },
      cleanup: { used: 14, limit: 40 },
      monitoring: { used: 0, limit: 20 },
      neon: { used: 0, limit: 40 },
    });
    assert.deepEqual(detail.unresolved, { requests: 1, mutations: 1 });
    assert.equal(JSON.stringify(detail).includes("private"), false);
    assert.deepEqual(
      Object.keys(detail).sort(),
      [
        "operation",
        "startedAt",
        "expiresAt",
        "outcome",
        "phase",
        "pendingUpload",
        "cleanupRequested",
        "objectRemoved",
        "budgets",
        "unresolved",
        "verdict",
      ].sort(),
    );
    assert.equal(await store.detail(randomUUID()), null);
    for (const limit of [0, 51, null])
      await assert.rejects(
        db.query("SELECT berth_executor.history_page(null,$1)", [limit]),
      );
    await assert.rejects(store.list(randomUUID()));
    await assert.rejects(store.list("bad-cursor"));
    assert.equal(
      historyTransactionModes.length,
      8,
      "probe the transaction mode for every History projection",
    );
    assert.ok(
      historyTransactionModes.every((mode) => mode === "on"),
      "every History projection must run in a read-only transaction",
    );
    await assert.rejects(
      db.query("SELECT berth_executor.history_record($1)", [ids[2]]),
      /permission denied/,
    );
    await assert.rejects(
      db.query("SELECT * FROM berth_ledger.trials"),
      /permission denied/,
    );
    const grants = (
      await owner.query(`SELECT p.proname, EXISTS(SELECT FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') AS public_execute
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='berth_executor' AND p.proname LIKE 'history_%'`)
    ).rows;
    assert.equal(grants.length, 3);
    assert.ok(grants.every((row) => row.public_execute === false));
    assert.deepEqual(await snapshot(), before);
  });
});
