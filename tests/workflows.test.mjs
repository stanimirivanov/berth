import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parse } from "yaml";
import { gitleaksVersion } from "../tools/secrets.mjs";

test("CI installs the pinned tools and runs canonical verification without cloud credentials", () => {
  const workflow = parse(readFileSync(".github/workflows/ci.yml", "utf8"));
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  assert.ok(Object.hasOwn(workflow.on, "pull_request"));
  assert.ok(Object.hasOwn(workflow.on, "push"));
  assert.ok(!Object.hasOwn(workflow.on, "pull_request_target"));
  assert.deepEqual(workflow.permissions, { contents: "read" });
  const job = workflow.jobs.verify;
  assert.ok(job["timeout-minutes"] <= 15);
  /** @type {{uses?:string,run?:string,with:Record<string,unknown>}[]} */
  const steps = job.steps;
  const node = steps.find((s) => s.uses?.startsWith("actions/setup-node@"));
  assert.ok(node);
  assert.equal(node.with["node-version"], pkg.engines.node);
  const checkout = steps.find((s) => s.uses?.startsWith("actions/checkout@"));
  assert.ok(checkout);
  assert.equal(checkout.with["fetch-depth"], 0);
  assert.equal(checkout.with["persist-credentials"], false);
  for (const s of steps.filter((s) => s.uses))
    assert.match(s.uses ?? "", /@[a-f0-9]{40}$/);
  const commands = steps.map((s) => s.run ?? "").join("\n");
  assert.ok(commands.includes(`pnpm@${pkg.engines.pnpm}`));
  assert.ok(
    commands.includes(
      `download/v${gitleaksVersion}/gitleaks_${gitleaksVersion}_linux_x64.tar.gz`,
    ),
  );
  assert.ok(commands.includes("sha256sum --check"));
  assert.ok(steps.some((s) => s.run === "pnpm check"));
  assert.ok(steps.some((s) => s.run === "pnpm run test:setup-db"));
  assert.ok(commands.includes('git show "$BASE_SHA:tools/floor.mjs"'));
  assert.ok(!JSON.stringify(workflow).includes("secrets."));
});

test("CI requires all four isolated recovery shards and propagates unsuccessful jobs", () => {
  const w = parse(readFileSync(".github/workflows/ci.yml", "utf8"));
  const recovery = w.jobs.recovery;
  assert.deepEqual(recovery.strategy.matrix.shard, [
    "1/4",
    "2/4",
    "3/4",
    "4/4",
  ]);
  assert.equal(recovery.strategy["fail-fast"], false);
  assert.equal(recovery["timeout-minutes"], 15);
  assert.deepEqual(recovery.services, w.jobs.verify.services);
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  assert.equal(recovery["continue-on-error"], undefined);
  for (const step of recovery.steps) {
    assert.equal(step["continue-on-error"], undefined);
    assert.equal(step.if, undefined);
    if (step.uses) assert.match(step.uses, /@[a-f0-9]{40}$/);
  }
  assert.ok(
    recovery.steps.some(
      (/** @type {{run?:string}} */ s) =>
        s.run ===
        `npm install --global pnpm@${pkg.engines.pnpm} --ignore-scripts`,
    ),
  );
  const setup = recovery.steps.find((/** @type {{uses?:string}} */ s) =>
    s.uses?.startsWith("actions/setup-node@"),
  );
  assert.equal(setup.with["node-version"], pkg.engines.node);
  const checkout = recovery.steps.find((/** @type {{uses?:string}} */ s) =>
    s.uses?.startsWith("actions/checkout@"),
  );
  assert.equal(checkout.with["persist-credentials"], false);
  assert.equal(checkout.with["fetch-depth"], 0);

  const run = recovery.steps.find(
    (/** @type {{run?:string}} */ s) => s.run === "pnpm run test:recovery-db",
  );
  assert.equal(run.env.BERTH_RECOVERY_SHARD, `\${{ matrix.shard }}`);
  assert.ok(
    recovery.steps.some(
      (/** @type {{run?:string}} */ s) => s.run === "pnpm run test:setup-db",
    ),
  );
  assert.deepEqual(w.jobs.check.needs, ["verify", "recovery"]);
  assert.equal(w.jobs.check.if, `\${{ always() }}`);
  const gate = w.jobs.check.steps[0];
  assert.equal(gate.env.VERIFY_RESULT, `\${{ needs.verify.result }}`);
  assert.equal(gate.env.RECOVERY_RESULT, `\${{ needs.recovery.result }}`);
  for (const result of ["success", "failure", "cancelled", "skipped"])
    for (const other of ["success", "failure", "cancelled", "skipped"])
      assert.equal(
        spawnSync("bash", ["-e", "-c", gate.run], {
          env: {
            ...process.env,
            VERIFY_RESULT: result,
            RECOVERY_RESULT: other,
          },
        }).status === 0,
        result === "success" && other === "success",
      );
});

test("temporary audit path retains canonical gates and has no continue-on-error bypass", () => {
  const workflow = parse(readFileSync(".github/workflows/ci.yml", "utf8"));
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  /** @type {{run?:string,uses?:string,if?:string,id?:string,"continue-on-error"?:boolean}[]} */
  const steps = workflow.jobs.verify.steps;
  const normal = steps.find((s) => s.run === "pnpm check");
  const temporary = steps.find(
    (s) => s.run === "pnpm run check:temporary-audit",
  );
  assert.ok(normal);
  assert.equal(temporary, undefined);
  assert.equal(normal.if, undefined);
  assert.equal(
    pkg.scripts["check:temporary-audit"],
    pkg.scripts.check.replace(
      "pnpm run security",
      "pnpm run security:temporary-audit",
    ),
  );
  assert.equal(
    pkg.scripts["security:temporary-audit"],
    "pnpm run secrets && node dist/scripts/temporary-audit.js",
  );
  for (const step of steps) assert.equal(step["continue-on-error"], undefined);
  assert.equal(
    steps.some((s) => s.id === "audit_policy"),
    false,
  );
  assert.equal(
    steps.some((s) => s.uses?.startsWith("actions/upload-artifact@")),
    false,
  );
});

test("advisory retirement restores unconditional canonical verification", () => {
  const workflow = parse(readFileSync(".github/workflows/ci.yml", "utf8"));
  /** @type {{run?:string,uses?:string,if?:string,id?:string,"continue-on-error"?:boolean}[]} */
  const steps = workflow.jobs.verify.steps;
  const canonical = steps.filter((s) => s.run === "pnpm check");
  assert.equal(canonical.length, 1);
  assert.equal(canonical[0]?.if, undefined);
  assert.equal(
    steps.some(
      (s) =>
        s.id === "audit_policy" || s.run?.includes("check:temporary-audit"),
    ),
    false,
  );
  for (const step of steps) assert.equal(step["continue-on-error"], undefined);
});
