import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Process-boundary test: fake only registry/audit I/O; use real policy, clock, hashing and journal writes.
test("temporary audit runner records native failure and rejects registry or report errors", async () => {
  const dir = await mkdtemp(join(tmpdir(), "berth-audit-test-"));
  const bin = join(dir, "bin");
  await mkdir(bin);
  const lock = await readFile("pnpm-lock.yaml");
  await writeFile(join(dir, "pnpm-lock.yaml"), lock);
  const cli = join(process.cwd(), "dist/scripts/temporary-audit.js");
  const git = (args: string[]) => {
    const r = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  git(["init", "--quiet"]);
  git(["add", "pnpm-lock.yaml"]);
  git([
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "fixture",
  ]);
  const commit = git(["rev-parse", "HEAD"]);
  git(["update-ref", "refs/remotes/origin/main", commit]);
  await writeFile(
    join(dir, ".git", "info", "exclude"),
    "bin/\nclean/\nnetwork/\nmalformed/\nexit-code/\nregistry-error/\ndrift/\ndirty/\n",
  );

  const fake = `#!${process.execPath}\nif(process.argv[2]==='view'){console.log(process.env.FIXTURE_LATEST ?? JSON.stringify('4.0.7'));process.exit(Number(process.env.FIXTURE_REGISTRY_STATUS ?? 0));}console.log(!process.argv.includes('--audit-level') ? (process.env.FIXTURE_FULL_REPORT ?? process.env.FIXTURE_REPORT) : process.env.FIXTURE_REPORT);process.exit(Number(process.env.FIXTURE_STATUS));\n`;
  await writeFile(join(bin, "pnpm"), fake, { mode: 0o700 });
  try {
    const clean = JSON.stringify({
      advisories: {},
      metadata: {
        vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0 },
      },
    });
    for (const [name, report, status, expected] of [
      ["clean", clean, "0", 0],
      ["network", JSON.stringify({ error: "network" }), "1", 1],
      ["malformed", "{", "1", 1],
      ["exit-code", clean, "2", 1],
    ] as const) {
      const result = spawnSync(process.execPath, [cli], {
        cwd: dir,
        encoding: "utf8",
        env: {
          ...process.env,
          GITHUB_SHA: commit,
          GITHUB_EVENT_NAME: "workflow_dispatch",
          GITHUB_EVENT_PATH: "",
          PATH: `${bin}:${process.env.PATH}`,
          RUNNER_TEMP: join(dir, name),
          FIXTURE_REPORT: report,
          FIXTURE_STATUS: status,
        },
        timeout: 10000,
      });
      assert.equal(result.status, expected, result.stderr);
      const saved = JSON.parse(
        await readFile(join(dir, name, "berth-audit", "evidence.json"), "utf8"),
      );
      assert.equal(saved.audit.stdout.trim(), report);
      assert.equal(saved.audit.status, Number(status));
    }
    const registryError = spawnSync(process.execPath, [cli], {
      cwd: dir,
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_SHA: commit,
        GITHUB_EVENT_NAME: "workflow_dispatch",
        GITHUB_EVENT_PATH: "",
        PATH: `${bin}:${process.env.PATH}`,
        RUNNER_TEMP: join(dir, "registry-error"),
        FIXTURE_REPORT: clean,
        FIXTURE_STATUS: "0",
        FIXTURE_REGISTRY_STATUS: "1",
      },
      timeout: 10000,
    });
    assert.equal(registryError.status, 1);
    const registryEvidence = JSON.parse(
      await readFile(
        join(dir, "registry-error", "berth-audit", "evidence.json"),
        "utf8",
      ),
    );
    assert.equal(registryEvidence.result, "rejected");
    const drift = spawnSync(process.execPath, [cli], {
      cwd: dir,
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_SHA: commit,
        GITHUB_EVENT_NAME: "workflow_dispatch",
        GITHUB_EVENT_PATH: "",
        PATH: `${bin}:${process.env.PATH}`,
        RUNNER_TEMP: join(dir, "drift"),
        FIXTURE_REPORT: clean,
        FIXTURE_FULL_REPORT: JSON.stringify({
          advisories: {
            bad: {
              severity: "critical",
              github_advisory_id: "GHSA-bad",
              module_name: "other",
              findings: [],
            },
          },
          metadata: {
            vulnerabilities: {
              info: 0,
              low: 0,
              moderate: 0,
              high: 0,
              critical: 1,
            },
          },
        }),
        FIXTURE_STATUS: "0",
      },
      timeout: 10000,
    });
    assert.equal(drift.status, 1);
    await writeFile(
      join(dir, "unreviewed.ts"),
      "export const changed = true;\n",
    );
    const dirty = spawnSync(process.execPath, [cli], {
      cwd: dir,
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_SHA: commit,
        GITHUB_EVENT_NAME: "workflow_dispatch",
        GITHUB_EVENT_PATH: "",
        PATH: `${bin}:${process.env.PATH}`,
        RUNNER_TEMP: join(dir, "dirty"),
        FIXTURE_REPORT: clean,
        FIXTURE_STATUS: "0",
      },
      timeout: 10000,
    });
    assert.equal(dirty.status, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
