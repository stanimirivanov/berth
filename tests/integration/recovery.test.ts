import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "pg";
import { makeLedger } from "../../src/trial/ledger.js";
import { classifyRecovery, cloudService } from "../fakes/faults.js";

import { recoverySites } from "../fakes/recovery-shard.js";

const port = Number(process.env.BERTH_TEST_POSTGRES_PORT);
assert.ok(
  Number.isInteger(port) && port > 0 && port < 65536,
  "Disposable loopback PostgreSQL required",
);
const operation = "00000000-0000-4000-8000-000000000013";
type Point = { label: string; occurrence: number };

/** Each seed owns fresh schemas and a provider outside all executor process lifetimes. */
async function fixture(
  work: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>,
  loss?: string,
  delay = false,
) {
  const f = await setup(loss, delay);
  try {
    await work(f);
  } finally {
    await f.close();
  }
}

async function setup(loss?: string, delay = false) {
  const owner = new Client({
    host: "127.0.0.1",
    port,
    database: "neondb",
    user: "neondb_owner",
    password: "berth-test-only",
  });
  await owner.connect();
  for (const file of ["001_trial", "002_executor", "003_usage"])
    await owner.query(await readFile(`migrations/${file}.sql`, "utf8"));
  const trial = await makeLedger(owner).start({
    operation,
    compartment: "ocid1.compartment.oc1..fixture",
    region: "eu-frankfurt-1",
    namespace: "fixture",
    digest: "fbbab289f7f94b25736c58be46a994c441fd02552cc6022352e3d86d2fab7c83",
    monitoringLimit: 20,
    neonLimit: 30,
  });
  const cloud = await cloudService(owner, loss, delay),
    dir = await mkdtemp(join(tmpdir(), "berth-checkpoint-"));
  let serial = 0;

  async function launch(
    fault?: Point,
    cancel = false,
    expireAfterReserve = false,
  ) {
    const n = ++serial,
      trace = join(dir, `${n}.jsonl`),
      result = join(dir, `${n}.result`),
      config = join(dir, `${n}.json`);
    await writeFile(trace, "");
    await writeFile(
      config,
      JSON.stringify({
        port,
        cloud: cloud.url,
        trace,
        result,
        fault,
        cancel,
        usage: true,
        expireAfterReserve,
        operation,
        delivery: createHash("sha256").update(`seed13:${n}`).digest("hex"),
        expiresAt: Date.parse(trial.expires_at),
      }),
    );
    const child = spawn(
      process.execPath,
      ["dist/tests/fakes/recovery-child.js", config],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    child.stdout.on("data", (b) => {
      output += String(b);
    });
    child.stderr.on("data", (b) => {
      output += String(b);
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 55000);
    const done = new Promise<{
      signal: string | null;
      phase: string;
      points: Point[];
    }>((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", async (code, signal) => {
        clearTimeout(timer);
        try {
          assert.ok(!output.includes("private-canary"), "Provider body leaked");
          assert.ok(code === 0 || signal === "SIGKILL", output);
          const points = (await readFile(trace, "utf8"))
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((s) => JSON.parse(s) as Point);
          const phase = signal
            ? "killed"
            : JSON.parse(await readFile(result, "utf8")).result?.phase;
          resolve({ signal, phase, points });
        } catch (e) {
          reject(e);
        }
      });
    });
    return { done };
  }

  const expire = () =>
    owner.query(
      "UPDATE berth_ledger.trials SET lease_until=clock_timestamp()-interval '1 second'",
    );

  async function evidence() {
    assert.deepEqual(cloud.violations, []);
    const row = (
      await owner.query(
        "SELECT *, (SELECT count(*)::int FROM berth_ledger.requests WHERE mutation AND outcome='unresolved') AS unknown, (SELECT pending_upload FROM berth_executor.work) AS pending_upload, (SELECT failed FROM berth_executor.work) AS failed, (SELECT reason FROM berth_executor.work) AS reason FROM berth_ledger.trials",
      )
    ).rows[0];
    assert.ok(
      row.normal_used <= 160 &&
        row.cleanup_used <= 40 &&
        row.monitoring_used <= 20 &&
        row.neon_used <= 30,
    );
    assert.ok(
      cloud.sdk.creates <= 1 && cloud.sdk.puts <= 1,
      "Mutation was replayed",
    );
    const attempts = (
      await owner.query(
        "SELECT action,count(*)::int AS n FROM berth_ledger.attempts GROUP BY action",
      )
    ).rows;
    for (const a of attempts)
      assert.ok(a.n <= 3, `attempt ceiling: ${a.action}`);
    if (["succeeded", "failed"].includes(row.outcome)) {
      assert.equal(row.unknown, 0);
      assert.equal(cloud.sdk.value, undefined);
      assert.equal(cloud.sdk.object, undefined);
    } else {
      assert.ok(["active", "needs-reconciliation"].includes(row.outcome));
      await assert.rejects(() =>
        makeLedger(owner).start({
          ...trial,
          operation: "00000000-0000-4000-8000-000000000099",
          monitoringLimit: 20,
          neonLimit: 30,
        }),
      );
    }
    const counts = (
      await owner.query(
        "SELECT meter,count(*)::int AS n FROM berth_ledger.requests GROUP BY meter",
      )
    ).rows;
    for (const c of counts)
      assert.equal(row[`${c.meter}_used`], c.n, `counter mismatch ${c.meter}`);
    assert.ok(
      row.unknown > 0 ||
        ["succeeded", "failed"].includes(row.outcome) ||
        (row.outcome === "needs-reconciliation" &&
          row.failed === true &&
          typeof row.reason === "string"),
      "recovery stalled without retained uncertainty",
    );
    return row;
  }

  async function converge() {
    // Stop when safe terminal or uncertainty cannot be resolved; no unlimited retry runner.
    for (let n = 0; n < 5; n++) {
      await expire();
      const r = await (await launch()).done;
      assert.notEqual(r.phase, "thrown");
      if (r.phase === "terminal") break;
      if (r.phase === "needs-reconciliation") {
        const unknown = (
          await owner.query(
            "SELECT count(*)::int AS n FROM berth_ledger.requests WHERE mutation AND outcome='unresolved'",
          )
        ).rows[0].n;
        if (unknown > 0 && !cloud.sdk.value) break;
      }
      if (r.phase === "observe") await (await launch(undefined, true)).done;
    }
    return evidence();
  }

  return {
    owner,
    cloud,
    launch,
    expire,
    evidence,
    converge,
    async close() {
      await cloud.close();
      for (const schema of ["berth_usage", "berth_executor", "berth_ledger"])
        await owner.query(`DROP SCHEMA ${schema} CASCADE`);
      await owner.end();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("checkpoint seed 13: process death at each observed semantic write boundary retains safe durable evidence", {
  timeout: 600000,
}, async (t) => {
  const sites = new Map<
    string,
    { step: number; point: Point; loss: string | undefined }
  >();
  // Success, lost create, lost upload and lost delete exercise distinct recovery-only writes.
  for (const loss of [
    undefined,
    "createBucket",
    "putObject",
    "deleteObject",
    "deleteBucket",
    "reject:createBucket",
    "reject:putObject",
  ]) {
    await fixture(async (f) => {
      for (let step = 0; step < 6; step++) {
        if (step === 2)
          await f.owner.query(
            "UPDATE berth_usage.state SET next_due=clock_timestamp()-interval '1 second'",
          );
        const r = await (await f.launch(undefined, step === 3)).done;
        for (const point of r.points)
          if (!sites.has(point.label))
            sites.set(point.label, { step, point, loss });
        if (r.phase === "terminal") break;
      }
      const baseline = await f.evidence();
      assert.ok(
        ["succeeded", "failed"].includes(baseline.outcome),
        `baseline ${loss ?? "success"}`,
      );
    }, loss);
  }
  assert.ok(sites.has("before:cloud.createBucket"));
  assert.ok(sites.has("after:cloud.deleteBucket"));
  assert.ok(sites.has("after:usage.record"));
  assert.ok([...sites.keys()].some((s) => s.includes("reconciled-provider")));
  t.diagnostic(
    `seed=13 semantic boundaries=${sites.size}; first occurrence per label per trajectory`,
  );
  const selected = recoverySites(
    [...sites.keys()],
    process.env.BERTH_RECOVERY_SHARD,
    process.env.BERTH_RECOVERY_POINT,
    Boolean(process.env.CI),
  );
  t.diagnostic(
    `recovery shard=${process.env.BERTH_RECOVERY_SHARD ?? "all"} selected=${selected.length}/${sites.size}`,
  );
  for (const [label, site] of sites) {
    if (!selected.includes(label)) continue;
    await t.test(label, () =>
      fixture(async (f) => {
        for (let step = 0; step <= site.step; step++) {
          if (step === 2)
            await f.owner.query(
              "UPDATE berth_usage.state SET next_due=clock_timestamp()-interval '1 second'",
            );
          const r = await (
            await f.launch(
              step === site.step ? site.point : undefined,
              step === 3,
            )
          ).done;
          if (step === site.step) {
            assert.equal(r.signal, "SIGKILL", `${label} was not reached`);
            assert.deepEqual(r.points.at(-1), site.point);
          }
        }
        const row = await f.converge();
        const classification = classifyRecovery(label, row);
        if (classification !== "terminal")
          t.diagnostic(
            `requires-owner: ${label}; unknown=${row.unknown}; pending-upload=${row.pending_upload}; reason=${row.reason}`,
          );
      }, site.loss),
    );
  }
});

test(
  "late accepted create completes after takeover while the stale executor is alive",
  { timeout: 60000 },
  () =>
    fixture(
      async (f) => {
        const old = await f.launch();
        await Promise.race([
          f.cloud.pending,
          new Promise((_, reject) =>
            setTimeout(
              () => reject(Error("create not accepted")),
              15000,
            ).unref(),
          ),
        ]);
        assert.equal((await (await f.launch()).done).phase, "busy");
        await f.expire();
        assert.equal(
          (await (await f.launch()).done).phase,
          "needs-reconciliation",
        );
        assert.equal(f.cloud.sdk.value, undefined);
        const checkpoint = (
          await f.owner.query(
            "SELECT to_jsonb(w) AS state FROM berth_executor.work w",
          )
        ).rows;
        f.cloud.release();
        await old.done;
        assert.deepEqual(
          (
            await f.owner.query(
              "SELECT to_jsonb(w) AS state FROM berth_executor.work w",
            )
          ).rows,
          checkpoint,
          "stale executor changed a checkpoint",
        );
        assert.equal(f.cloud.sdk.creates, 1);
        const before = (
          await f.owner.query(
            "SELECT outcome FROM berth_ledger.requests WHERE mutation",
          )
        ).rows;
        assert.deepEqual(
          before,
          [{ outcome: "unresolved" }],
          "stale writer settled accepted create",
        );
        const row = await f.converge();
        assert.ok(["succeeded", "failed"].includes(row.outcome));
        assert.equal(f.cloud.sdk.creates, 1);
      },
      undefined,
      true,
    ),
);

test("recovery-only settlement boundaries survive another process death", {
  timeout: 120000,
}, async (t) => {
  for (const mode of ["read-interruption", "not-dispatched"]) {
    const seed =
      mode === "read-interruption"
        ? { label: "after:ledger.reserve:inspect", occurrence: 1 }
        : undefined;
    let targets: Point[] = [];
    await fixture(async (f) => {
      const first = await (
        await f.launch(seed, false, mode === "not-dispatched")
      ).done;
      if (seed) assert.equal(first.signal, "SIGKILL");
      await f.expire();
      const trace = seed
        ? (await (await f.launch()).done).points
        : first.points;
      targets = trace.filter((p) =>
        p.label.includes(
          mode === "read-interruption"
            ? "read-only-interruption"
            : "not-dispatched",
        ),
      );
      assert.equal(targets.length, 2, `both settlement boundaries: ${mode}`);
      await f.converge();
    });
    for (const point of targets)
      await t.test(point.label, () =>
        fixture(async (f) => {
          if (seed) {
            assert.equal((await (await f.launch(seed)).done).signal, "SIGKILL");
            await f.expire();
          }
          const r = await (
            await f.launch(point, false, mode === "not-dispatched")
          ).done;
          assert.equal(r.signal, "SIGKILL");
          assert.deepEqual(r.points.at(-1), point);
          await f.converge();
        }),
      );
  }
});

test(
  "corrupted stored bytes block cleanup and preserve the owned object for reconciliation",
  { timeout: 30000 },
  () =>
    fixture(async (f) => {
      assert.equal((await (await f.launch()).done).phase, "object");
      assert.equal((await (await f.launch()).done).phase, "observe");
      assert.ok(f.cloud.sdk.object);
      f.cloud.sdk.object.body[0] = 255;
      await (await f.launch(undefined, true)).done;
      assert.equal(
        (await (await f.launch()).done).phase,
        "needs-reconciliation",
      );
      assert.equal(f.cloud.sdk.object.body[0], 255);
      assert.equal(f.cloud.sdk.objectDeletes, 0);
      const row = await f.evidence();
      assert.equal(row.outcome, "needs-reconciliation");
      assert.equal(row.reason, "unresolved-provider-call");
    }),
);

test("interrupted object deletion completes owned teardown within the unchanged reserve", {
  timeout: 60000,
}, async (t) => {
  for (const label of [
    "before:ledger.begin:delete_object",
    "after:ledger.begin:delete_object",
    "before:ledger.reserve:delete_object",
  ]) {
    await t.test(label, () =>
      fixture(async (f) => {
        assert.equal((await (await f.launch()).done).phase, "object");
        assert.equal((await (await f.launch()).done).phase, "observe");
        await (await f.launch(undefined, true)).done;
        const killed = await (await f.launch({ label, occurrence: 1 })).done;
        assert.equal(killed.signal, "SIGKILL");
        assert.equal(f.cloud.sdk.objectDeletes, 0);
        const row = await f.converge();
        assert.ok(
          ["succeeded", "failed"].includes(row.outcome),
          `${label}: cleanup=${row.cleanup_used}, outcome=${row.outcome}`,
        );
        assert.equal(row.unknown, 0);
        assert.ok(row.cleanup_used <= 40);
        assert.equal(f.cloud.sdk.object, undefined);
        assert.equal(f.cloud.sdk.value, undefined);
        assert.equal(f.cloud.sdk.objectDeletes, 1);
        assert.equal(f.cloud.sdk.deletes, 1);
        t.diagnostic(`${label}: cleanup requests=${row.cleanup_used}/40`);
      }),
    );
  }
});

/** Real executor/SDK recovery fixture with local SQL and an in-memory HTTP boundary only. */
async function ownerRecoveryFixture(
  work: (f: Awaited<ReturnType<typeof ownerRecoverySetup>>) => Promise<void>,
) {
  const f = await ownerRecoverySetup();
  try {
    await work(f);
  } finally {
    await f.close();
  }
}

/** No Functions service participates; a fresh SDK and SQL connection represent each owner invocation. */
async function ownerRecoverySetup() {
  const { generateKeyPairSync } = await import("node:crypto");
  const { safeBucketSdk } = await import("../../src/providers/oci/client.js");
  const { executeLive } = await import("../../src/trial/live-runtime.js");
  const { OciWire } = await import("../fakes/oci-wire.js");
  const owner = new Client({
    host: "127.0.0.1",
    port,
    database: "neondb",
    user: "neondb_owner",
    password: "berth-test-only",
  });
  await owner.connect();
  const id = "00000000-0000-4000-8000-000000000001",
    start = Date.now() - 1000;
  const wire = new OciWire();
  const env = {
    compartment: "ocid1.compartment.oc1..fixture",
    namespace: "fixture",
    region: "eu-frankfurt-1",
    tenancy: "ocid1.tenancy.oc1..fixture",
    user: "ocid1.user.oc1..fixture",
    fingerprint: "fixture",
    monitoringLimit: 20,
    neonLimit: 64,
    operation: id,
    startedAt: start,
    expiresAt: start + 14400000,
    token: "a".repeat(40),
    previewKey: "b".repeat(40),
    connection: "unused",
    privateKey: generateKeyPairSync("rsa", { modulusLength: 2048 })
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString(),
  };
  const binding = {
    compartment: env.compartment,
    namespace: env.namespace,
    region: env.region,
    tenancy: env.tenancy,
    user: env.user,
    fingerprint: env.fingerprint,
    monitoringLimit: 20,
    neonLimit: 64,
  };
  for (const file of [
    "001_trial",
    "002_executor",
    "003_usage",
    "004_admission",
    "005_functions_exception",
    "006_free_functions_policy",
  ])
    await owner.query(await readFile(`migrations/${file}.sql`, "utf8"));
  await owner.query("SELECT berth_executor.prepare($1,$2,$3,$4)", [
    id,
    new Date(start),
    JSON.stringify(binding),
    JSON.stringify({
      checkedAt: start,
      iamCheckedAt: start,
      iamReviewed: true,
      accountType: "always-free",
      homeRegion: env.region,
      neonFree: true,
      storageBytes: 10485760,
      objectRequests: 200,
      transferBytes: 1048576,
      monitoringRequests: 20,
      functionsMode: "free-plan-unknown-v1",
      functionsUsage: "unknown",
      functionsAllowance: "unknown",
      functionsPolicy: {
        operation: id,
        startedAt: start,
        expiresAt: env.expiresAt,
        shutdownBy: env.expiresAt + 900000,
        policyVersion: "free-plan-v1",
        reviewer: "offline-owner",
        otherServicesEvidence: "offline-envelope",
        unknownAllowanceAccepted: true,
        partialVerdictAccepted: true,
        exclusiveProjectUse: true,
        manualRecoveryReady: true,
        probeClientMs: 2252,
        scenario: "64x60-plus36x60-v1",
        plan: {
          status: "free",
          source: "owner-console",
          checkedAt: start,
          project: "offline-project",
          branch: "offline-branch",
          period: "offline-period",
          evidence: "offline-plan",
        },
        billing: {
          reviewedAt: start,
          source: "neon-free-no-overage-2026-11-19",
          evidence: "offline-billing",
        },
        allowances: {
          postgresStorageBytes: 10485760,
          requiredPostgresStorageBytes: 1048576,
          postgresComputeCuSeconds: 36000,
          requiredPostgresComputeCuSeconds: 28800,
          sharedTransferBytes: 10485760,
          requiredSharedTransferBytes: 1048576,
        },
      },
    }),
  ]);
  // Synthetic owner receipt only; real IAM verification remains a live acceptance gap.
  await owner.query(
    "UPDATE berth_executor.admission SET verified_at=clock_timestamp() WHERE operation=$1",
    [id],
  );
  await owner.query("SELECT berth_executor.admit($1,$2)", [
    id,
    JSON.stringify(binding),
  ]);
  const wireReservations = new Set<string>();
  let uncertainUpload = false,
    extraObject = false,
    sqlUnavailable = false;
  const ports = {
    database: () => {
      const db = new Client({
        host: "127.0.0.1",
        port,
        database: "neondb",
        user: "berth_runtime",
        password: "test-runtime-only",
      });
      return {
        connect: async () => {
          if (sqlUnavailable) throw Error("SQL unavailable");
          await db.connect();
        },
        query: (text: string, values?: readonly unknown[]) =>
          db.query(text, values ? [...values] : []),
        end: () => db.end(),
      };
    },
    fetch: async () => {
      throw Error("Network is forbidden in owner recovery drill");
    },
    sdk: () =>
      safeBucketSdk({
        send: async (request) => {
          const reserved = (
            await owner.query(
              "SELECT id FROM berth_ledger.requests WHERE operation=$1 AND outcome='unresolved' AND meter IN ('normal','cleanup') ORDER BY reserved_at DESC LIMIT 1",
              [id],
            )
          ).rows[0]?.id;
          assert.equal(
            typeof reserved,
            "string",
            "Every SDK send requires a durable SQL reservation",
          );
          assert.equal(
            wireReservations.has(reserved),
            false,
            "No SDK retry may reuse a reservation",
          );
          wireReservations.add(reserved);
          if (uncertainUpload && request.method === "PUT")
            throw Error("Upload response uncertain before model observation");
          const response = await wire.send(request);
          if (
            extraObject &&
            request.method === "GET" &&
            new URL(request.uri).pathname.endsWith("/o")
          ) {
            const body = await response.json();
            return Response.json({
              ...body,
              objects: [
                ...body.objects,
                { name: "foreign.bin", size: 1, etag: "foreign" },
              ],
            });
          }
          return response;
        },
      }),
  };
  let serial = 0;
  return {
    owner,
    wire,
    wireReservations,
    env,
    faults: (v: {
      uncertainUpload?: boolean;
      extraObject?: boolean;
      sqlUnavailable?: boolean;
    }) => {
      uncertainUpload = v.uncertainUpload ?? false;
      extraObject = v.extraObject ?? false;
      sqlUnavailable = v.sqlUnavailable ?? false;
    },
    invoke: () =>
      executeLive(
        env,
        "scheduled",
        `offline-owner-${++serial}`,
        ports,
      ) as Promise<{ phase: string }>,
    cancel: () => executeLive(env, "cleanup", undefined, ports),
    report: async () =>
      (await owner.query("SELECT berth_executor.report($1) AS value", [id]))
        .rows[0].value,
    unresolved: async () =>
      Number(
        (
          await owner.query(
            "SELECT count(*) FROM berth_ledger.requests WHERE operation=$1 AND outcome='unresolved'",
            [id],
          )
        ).rows[0].count,
      ),
    close: async () => {
      for (const schema of ["berth_usage", "berth_executor", "berth_ledger"])
        await owner.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await owner.end();
    },
  };
}

test("independent owner cleanup survives hosted loss and accepted DELETE response loss with the real SDK and unchanged reserve", async (t) => {
  for (const lost of [false, true])
    await t.test(lost ? "lost-delete-response" : "hosting-unavailable", () =>
      ownerRecoveryFixture(async (f) => {
        assert.equal((await f.invoke()).phase, "observe");
        assert.ok(f.wire.object);
        Object.assign(f.wire, { loseDeleteResponse: lost });
        await f.cancel();
        const first = await f.invoke();
        const spent = (await f.report()).trial.cleanup_used;
        let uncertainId: string | undefined;
        if (lost) {
          assert.equal(
            (await f.report()).trial.outcome,
            "needs-reconciliation",
          );
          const uncertain = (
            await f.owner.query(
              "SELECT id FROM berth_ledger.requests WHERE operation=$1 AND mutation AND outcome='unresolved'",
              [f.env.operation],
            )
          ).rows;
          assert.equal(uncertain.length, 1);
          uncertainId = uncertain[0].id;
        } else assert.equal(first.phase, "terminal");
        if (lost) await f.invoke();
        const report = await f.report();
        assert.ok(["succeeded", "failed"].includes(report.trial.outcome));
        assert.equal(report.feasibility.verdict, "partial");
        assert.equal(report.feasibility.functionsAllowance, "unknown");
        assert.equal(f.wire.object, undefined);
        assert.equal(f.wire.bucket, undefined);
        assert.equal(await f.unresolved(), 0);
        assert.ok(report.trial.cleanup_used >= spent);
        assert.equal(
          report.trial.normal_used + report.trial.cleanup_used,
          f.wireReservations.size,
        );
        if (uncertainId)
          assert.deepEqual(
            (
              await f.owner.query(
                "SELECT meter,outcome,basis FROM berth_ledger.requests WHERE id=$1",
                [uncertainId],
              )
            ).rows[0],
            {
              meter: "cleanup",
              outcome: "succeeded",
              basis: "reconciled-provider",
            },
          );
        assert.ok(report.trial.cleanup_used <= 40);
        assert.ok(report.trial.normal_used <= 160);
        assert.equal(
          f.wire.requests.filter((r) => r.method === "DELETE").length,
          2,
        );
        assert.ok(
          f.wire.requests
            .filter((r) => r.method === "DELETE")
            .every((r) => r.headers.has("if-match")),
        );
        t.diagnostic(
          `${lost ? "lost DELETE" : "clean"}: normal=${report.trial.normal_used}/160 cleanup=${report.trial.cleanup_used}/40`,
        );
      }),
    );
});

test("owner recovery refuses unknown contents uncertain uploads exhausted reserves expiry and missing SQL evidence", async (t) => {
  for (const fault of [
    "contents",
    "upload",
    "reserve",
    "expiry",
    "sql",
  ] as const)
    await t.test(fault, () =>
      ownerRecoveryFixture(async (f) => {
        if (fault === "upload") f.faults({ uncertainUpload: true });
        await f.invoke();
        const before = f.wire.requests.length;
        if (fault === "contents") f.faults({ extraObject: true });
        if (fault === "reserve")
          await f.owner.query(
            "UPDATE berth_ledger.trials SET cleanup_used=40 WHERE operation=$1",
            [f.env.operation],
          );
        if (fault === "expiry") {
          f.env.expiresAt = Date.now() - 1000;
          f.env.startedAt = f.env.expiresAt - 14400000;
          await f.owner.query(
            "UPDATE berth_ledger.trials SET started_at=$2,expires_at=$3 WHERE operation=$1",
            [
              f.env.operation,
              new Date(f.env.startedAt),
              new Date(f.env.expiresAt),
            ],
          );
        }
        if (fault === "sql") {
          f.faults({ sqlUnavailable: true });
          await assert.rejects(f.cancel());
        } else {
          await f.cancel();
          await f.invoke();
        }
        const report = await f.report();
        assert.ok(f.wire.bucket);
        assert.equal(
          f.wire.requests.filter((r) => r.method === "DELETE").length,
          0,
        );
        assert.ok(report.trial.cleanup_used <= 40);
        assert.equal(report.feasibility.verdict, "partial");
        if (["sql", "expiry", "reserve"].includes(fault))
          assert.equal(f.wire.requests.length, before);
        if (fault === "upload") assert.ok((await f.unresolved()) > 0);
      }),
    );
});
