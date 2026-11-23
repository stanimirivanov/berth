import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectAuditDiff } from "./audit-diff.ts";
import { evaluateException } from "./audit-exception.ts";

// Historical command retained for diagnostics; #59 retired its approval after the native gate cleared.
const formerExpiresAt = Date.parse("2026-11-25T00:00:00Z");
const directory = join(process.env.RUNNER_TEMP ?? tmpdir(), "berth-audit");
mkdirSync(directory, { recursive: true, mode: 0o700 });

/** Bound each native command; collection failures are data and never qualify as an audit finding. */
function collect(args: string[]) {
  const result = spawnSync("pnpm", args, {
    encoding: "utf8",
    timeout: 60000,
    maxBuffer: 4 * 1024 * 1024,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error?.message ?? null,
    signal: result.signal,
  };
}

const startedAt = Date.now();
const audit = collect(["audit", "--audit-level", "high", "--json"]);
const fullAudit = collect(["audit", "--json"]);
const registry = collect(["view", "picomatch", "version", "--json"]);
const observedAt = Date.now();
let diff: ReturnType<typeof collectAuditDiff> | undefined;
try {
  diff = collectAuditDiff();
} catch {
  /* Evidence failure rejects below; no approval is inferred. */
}
const commit = diff?.commit ?? "";
let result: ReturnType<typeof evaluateException> = "rejected";
try {
  const latest: unknown = JSON.parse(registry.stdout);
  const filtered = JSON.parse(audit.stdout),
    full = JSON.parse(fullAudit.stdout);
  const severe = (value: {
    advisories: Record<
      string,
      {
        severity: string;
        github_advisory_id: string;
        module_name: string;
        findings: { version: string; paths: string[] }[];
      }
    >;
  }) =>
    Object.values(value.advisories)
      .filter((a) => ["high", "critical"].includes(a.severity))
      .map((a) =>
        JSON.stringify([
          a.github_advisory_id,
          a.severity,
          a.module_name,
          a.findings.map((f) => [f.version, [...f.paths].sort()]).sort(),
        ]),
      )
      .sort();
  if (Object.keys(filtered).sort().join(",") !== "advisories,metadata")
    throw Error("gate-schema");
  const totals: unknown[] = Object.values(full.metadata.vulnerabilities);
  if (
    totals.some(
      (v) => typeof v !== "number" || !Number.isInteger(v) || v < 0,
    ) ||
    fullAudit.status !==
      (totals.some((v) => typeof v === "number" && v > 0) ? 1 : 0)
  )
    throw Error("full-audit-status");
  if (
    JSON.stringify(severe(filtered)) !== JSON.stringify(severe(full)) ||
    JSON.stringify(filtered.metadata.vulnerabilities) !==
      JSON.stringify(full.metadata.vulnerabilities) ||
    fullAudit.error ||
    fullAudit.signal ||
    ![0, 1].includes(fullAudit.status ?? -1)
  )
    throw Error("audit-drift");
  if (
    audit.error ||
    audit.signal ||
    registry.error ||
    registry.signal ||
    registry.status !== 0 ||
    typeof latest !== "string" ||
    !/^\d+\.\d+\.\d+$/.test(latest)
  )
    throw Error("collection");
  result = evaluateException(fullAudit.stdout, {
    scope: "verification",
    now: Date.now(),
    observedAt: startedAt,
    exitCode: audit.status ?? -1,
    lockfileHash: createHash("sha256")
      .update(readFileSync("pnpm-lock.yaml"))
      .digest("hex"),
    commit,
    reportCommit: commit,
    complete: true,
    diffComplete: diff?.complete === true,
    supportedFixAvailable: latest !== "4.0.7",
    assumptionsUnchanged: true,
    approval: undefined,
    changes: [],
  });
} catch {
  result = "rejected";
}
const evidence = {
  startedAt,
  observedAt,
  commit,
  run: process.env.GITHUB_RUN_ID ?? "local",
  result,
  exceptionStatus: "retired",
  nativeRemovalPrerequisiteMet: result === "clean",
  diff,
  audit,
  fullAudit,
  registry,
  owner: "Stanimir",
  issue: 59,
  formerExpiresAt,
};
writeFileSync(
  join(directory, "evidence.json"),
  JSON.stringify(evidence, null, 2),
  { mode: 0o600 },
);
const summary = `Audit result: ${result}. Native audit exit: ${audit.status}. Exception: retired (#59); no advisory is waived. Native removal prerequisite: ${result === "clean" ? "met" : "not met"}. This does not authorize deployment or a live trial. Raw evidence: ${directory}/evidence.json`;
console.log(summary);
if (process.env.GITHUB_STEP_SUMMARY)
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
if (result === "rejected") process.exitCode = 1;
