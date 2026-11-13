import assert from "node:assert/strict";
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
  const job = workflow.jobs.check;
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
