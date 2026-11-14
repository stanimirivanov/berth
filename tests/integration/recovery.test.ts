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
  const selected = process.env.BERTH_RECOVERY_POINT;
  assert.ok(!selected || sites.has(selected), "Unknown checkpoint selection");
  for (const [label, site] of sites) {
    if (selected && label !== selected) continue;
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
