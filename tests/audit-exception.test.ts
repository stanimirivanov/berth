import assert from "node:assert/strict";
import test from "node:test";
import {
  type ExceptionContext,
  evaluateException,
} from "../scripts/audit-exception.ts";
import { picomatchReport as report } from "./fakes/audit-report.ts";

const now = Date.parse("2026-11-19T12:00:00Z");
const expiry = Date.parse("2026-11-25T00:00:00Z");
const hash = "44204ec7857c2de9744a9e807f31a51eda502e9fc8041b6e1529ae374ac282a8";

function context(): ExceptionContext {
  return {
    now,
    observedAt: now,
    exitCode: 1,
    lockfileHash: hash,
    commit: "a".repeat(40),
    reportCommit: "a".repeat(40),
    complete: true,
    diffComplete: true,
    supportedFixAvailable: false,
    assumptionsUnchanged: true,
    approval: {
      owner: "Stanimir",
      issue: 59,
      approvedAt: now - 1000,
      expiresAt: expiry,
    },
    changes: [
      {
        path: "docs/trial/owner-closeout.md",
        status: "M",
        oldMode: "100644",
        newMode: "100644",
      },
    ],
  };
}

test("offline qualification distinguishes temporary exception from clean audit", () => {
  assert.equal(
    evaluateException(JSON.stringify(report()), context()),
    "temporary-exception",
  );
  const clean = {
    advisories: {},
    metadata: {
      vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0 },
    },
  };
  assert.equal(
    evaluateException(JSON.stringify(clean), {
      ...context(),
      exitCode: 0,
      approval: undefined,
    }),
    "clean",
  );
});

test("exception rejects missing approval expiry drift stale evidence and unsafe diffs", () => {
  const c = context();
  const approval = c.approval,
    change = c.changes[0];
  assert.ok(approval);
  assert.ok(change);
  const invalid: ExceptionContext[] = [
    { ...c, approval: undefined },
    { ...c, now: expiry, observedAt: expiry },
    { ...c, now: NaN },
    { ...c, approval: { ...approval, approvedAt: now + 1 } },
    { ...c, approval: { ...approval, expiresAt: expiry + 1 } },
    { ...c, approval: { ...approval, owner: "unknown" } },
    { ...c, approval: { ...approval, issue: 1 } },
    { ...c, observedAt: now - 300001 },
    { ...c, observedAt: now + 1 },
    { ...c, reportCommit: "b".repeat(40) },
    { ...c, lockfileHash: "b".repeat(64) },
    { ...c, complete: false },
    { ...c, diffComplete: false },
    { ...c, exitCode: 2 },
    { ...c, supportedFixAvailable: true },
    { ...c, assumptionsUnchanged: false },
    { ...c, changes: [] },
    ...[
      "package.json",
      "docs/../package.json",
      "docs/security/picomatch-exception-proposal.md",
      "docs/x.md/evil",
      "/docs/x.md",
    ].map((path) => ({ ...c, changes: [{ ...change, path }] })),
    ...["D", "R100"].map((status) => ({
      ...c,
      changes: [{ ...change, status }],
    })),
    { ...c, changes: [{ ...change, newMode: "120000" }] },
  ];
  for (const x of invalid)
    assert.equal(
      evaluateException(JSON.stringify(report()), x),
      "rejected",
      JSON.stringify(x),
    );
  assert.equal(
    evaluateException(JSON.stringify(report()), {
      ...c,
      now: expiry - 1,
      observedAt: expiry - 1,
    }),
    "temporary-exception",
  );
});

test("native audit errors inconsistent counts extra findings and altered advisory fail closed", () => {
  const c = context();
  for (const text of [
    "",
    "{",
    "null",
    "{}",
    JSON.stringify({ ...report(), error: "network" }),
    JSON.stringify({ ...report(), unexpected: true }),
  ])
    assert.equal(evaluateException(text, c), "rejected");
  for (const change of [
    { module_name: "other" },
    { severity: "critical" },
    { github_advisory_id: "other" },
    { patched_versions: ">=4.0.8" },
    { url: "https://example.com" },
    { findings: [] },
    { findings: [{ version: "4.0.6", paths: [".>alchemy>picomatch"] }] },
    { findings: [{ version: "4.0.7", paths: [] }] },
    { findings: [{ version: "4.0.7", paths: [".>other"] }] },
  ]) {
    const x = report();
    Object.assign(x.advisories["1247710"], change);
    assert.equal(evaluateException(JSON.stringify(x), c), "rejected");
  }
  const x = report();
  x.metadata.vulnerabilities.high = 0;
  assert.equal(evaluateException(JSON.stringify(x), c), "rejected");
  const y = report();
  y.advisories["1247710"].findings.push({
    version: "4.0.6",
    paths: [".>picomatch"],
    dev: false,
    optional: false,
    bundled: false,
  });
  assert.equal(evaluateException(JSON.stringify(y), c), "rejected");
});

test("additional severe findings fail even when metadata agrees and all paths are inspected", () => {
  const x = report();
  const doubled = {
    ...x,
    advisories: {
      ...x.advisories,
      "123": {
        ...x.advisories["1247710"],
        id: 123,
        module_name: "other",
        github_advisory_id: "GHSA-aaaa-bbbb-cccc",
      },
    },
    metadata: { vulnerabilities: { ...x.metadata.vulnerabilities, high: 2 } },
  };
  assert.equal(
    evaluateException(JSON.stringify(doubled), context()),
    "rejected",
  );
  x.advisories["1247710"].findings[0]?.paths.push(".>unknown>picomatch");
  assert.equal(evaluateException(JSON.stringify(x), context()), "rejected");
  const c = context();
  assert.equal(
    evaluateException(JSON.stringify(report()), {
      ...c,
      changes: [
        {
          path: "docs/new.md",
          status: "A",
          oldMode: "000000",
          newMode: "100644",
        },
      ],
    }),
    "temporary-exception",
  );
});

test("truncated path inventory cannot qualify despite a complete flag", () => {
  const x = report();
  x.advisories["1247710"].findings[0]?.paths.pop();
  assert.equal(evaluateException(JSON.stringify(x), context()), "rejected");
});

test("approved verification scope qualifies code checks without claiming an audit clean", () => {
  const c = { ...context(), scope: "verification" as const, changes: [] };
  assert.equal(
    evaluateException(JSON.stringify(report()), c),
    "temporary-exception",
  );
  assert.equal(
    evaluateException(JSON.stringify(report()), {
      ...c,
      now: expiry,
      observedAt: expiry,
    }),
    "rejected",
  );
  assert.equal(
    evaluateException(JSON.stringify(report()), {
      ...c,
      lockfileHash: "wrong",
    }),
    "rejected",
  );
});
