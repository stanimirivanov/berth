# Offline exception evaluator — #62

`scripts/audit-exception.ts` exports a pure `evaluateException(report, context)`
function. It performs no audit/network/process/file operation and has no CLI or
CI integration. It cannot authenticate approval, activate an exception, authorize a
merge, or verify a clock. The [proposal](picomatch-exception-proposal.md) remains
inactive. PRs #50/#60 remain draft; #59 remains open.

## Contract

Input report: complete JSON from the pinned pnpm native audit, with `advisories`
and `metadata.vulnerabilities`. The evaluator rejects parse/schema errors, reports
over 4 MiB, inconsistent severity counts, malformed findings and unexpected exit
codes. Each severe finding must be exactly the bound picomatch advisory, high,
version 4.0.7, with no published patched range. All 26 known paths for the fixed
lockfile must be present exactly once. Additional or missing paths fail closed.
Low/moderate findings remain represented and counted, under existing policy.

Results:

- `clean`: no high/critical findings and exit code zero. This refers to the existing
  high-severity threshold, not absence of low/moderate findings.
- `temporary-exception`: native audit still failed (exit code one), but supplied
  context and every severe finding satisfy the candidate exception bindings.
- `rejected`: malformed/incomplete/unqualified input, including an audit error.

Context requires matching current/report commit IDs, a complete audit and full diff,
fresh observation at most five minutes old and not future-dated, exact lockfile
SHA-256, and explicit owner/issue/approval/expiry bindings. Expiry is strictly before
November 25 00:00 UTC; the exact instant is rejected. A supported fix or changed
reachability assumptions invalidates qualification. Ordinary clean reports do not
require exception approval; report provenance/freshness requirements still apply.

Eligible diffs are nonempty additions/modifications of regular, non-executable
Markdown files under docs or tasks/plan.md. Traversal, hidden path components,
renames/deletions and symlink/executable modes are rejected. All docs/security edits
are excluded as a conservative policy-authoring boundary. This is deliberately
stricter than accepting a policy edit as its own qualification evidence.

## Trust boundary and deferred integration

Every context field is an assertion from a future trusted collector. A caller can
fabricate a matching owner string, commit, digest, time or boolean; this pure
function does not make those assertions authentic. Do not expose it as an API or
use client-provided context for CI admission. It also cannot inspect file contents
for disguised executable payloads. Reviewed ordinary Markdown is a separate trust
requirement. No policy approval record is added in this PR.

Before activation, a separate reviewed implementation must acquire native audit
output/exit status freshly, verify the actual lockfile and complete merge-base diff
(including content/type/mode), authenticate the owner's approval and current UTC
clock, and obtain supported-fix/reachability review evidence. It must retain the
raw report with run/commit identity and distinguish exception qualification from
an audit-clean result in required checks. It must not modify existing `pnpm check`
or native audit behavior. Branch-protection changes require owner review.

## Tests and limits

`pnpm build && node --test dist/tests/audit-exception.test.js` exercises positive,
clean, pre-expiry/exact-expiry and rejection controls. The first positive tests
failed against an always-rejecting implementation before logic was added. Tests
cover missing/altered approval, stale/future evidence, digest/commit drift, unsafe
diffs, extra severe findings, wrong versions/advisories, malformed metadata and
truncated path inventories. Fixtures use public synthetic advisory data, no secrets.
They establish evaluator behavior, not security of the vulnerable matcher or any
trusted collector. Recovery suites and application budgets are untouched.

Verification on 2026-11-18: canonical `pnpm check` passed fast gates, all 163
application tests, 28 harness tests, bundle and secret scan, then failed the
unchanged native audit gate (one high / seven moderate / one low finding).
Review isolated the expiry test from stale-evidence rejection; weakening `>=` to
`>` then failed that boundary test, and restoring it passed the focused suite.
No production behavior or SQL recovery tests changed. Trusted CI integration and
owner activation are still unimplemented, so this PR cannot unblock a merge.
