# Proposed temporary picomatch exception — #59

**Historical proposal: superseded by owner-requested verification implementation in PR #63.**
See [implemented scope, commands and expiry](audit-exception-evaluator.md). The
original proposal below is retained as history; it does not describe current activation.

**Original status: proposed, inactive.** Preparing or merging this document does not bypass
an audit check. The owner must explicitly approve the policy below before a
separate, tested enforcement change can activate it. Existing `pnpm check` remains
red on the high advisory. PRs #50 and #60 remain drafts.

## Purpose, owner and time boundary

Permit review and merge of security-assessment and owner-closeout documentation
while the published dependency remains unpatched. This accepts a short-lived
repository dependency-policy deviation, not a claim that picomatch is safe.

- Risk owner and approver: Berth repository owner (Stanimir).
- Tracking/removal issue: [#59](https://github.com/stanimirivanov/berth/issues/59),
  which stays open until remediation is verified or this exception is removed.
- Proposed earliest activation: explicit owner approval followed by the reviewed
  enforcement PR; never retroactive.
- Hard expiry: **2026-11-25 00:00:00 UTC**, **November 25 at 02:00 Sofia**.
  Approval after this instant cannot activate this proposal.
- Interim upstream review: **2026-11-20**, owned by the repository maintainer.
- No automatic renewal, rolling duration, grace period or CI-clock override.
  A renewal requires a new explicit risk decision and reviewed policy change.

## Exact eligible dependency and advisory

Only this combination may receive temporary exception classification:

| Binding | Required value |
| --- | --- |
| Package | `picomatch` |
| Resolved version | Exactly `4.0.7` |
| Advisory | `GHSA-fc5q-39xc-vjpf` / CVE-2026-112366 |
| Accepted severity | High; escalation to critical invalidates the exception |
| Lockfile SHA-256 | `44204ec7857c2de9744a9e807f31a51eda502e9fc8041b6e1529ae374ac282a8` |
| Evidence baseline | [Assessment](picomatch-triage.md), source commit `9c85ddb775588cbd2b2d5c98f572adfdcec5b87f` |

All dependency paths to this exact resolution are covered; do not assume there is
only one path because there is one installed version. Different versions,
additional high/critical advisories, changed identifiers/severity, altered lockfile,
missing evidence or audit errors invalidate qualification. Existing moderate/low
findings retain the current policy and must remain visible. No dependency override,
fork, patch-package replacement or advisory-ignore entry is authorized here.

## Eligible changes and residual risk

Only changes to reviewed Markdown files under `docs/` and `tasks/plan.md` qualify.
The proposed enforcement implementation itself requires separate review under the
existing policy; it cannot self-authorize through this documentation allowance.
Executable source, tests, dependencies, lockfile, workflows, configuration and
scripts do not qualify for subsequent use of the exception. Assess the entire PR
diff against its trusted merge base, including renames, deletions and file modes;
reject symlinks or files merely disguised with a Markdown suffix.

The current fixed hosted route has no identified caller-supplied glob, but source
review is not universal non-reachability proof. Build/CLI globbing is affected and
an adversarial local pattern exceeded the bounded reproduction timeout. Treat
source/configuration as trusted developer input only; do not process supplied glob
patterns from external requests or unreviewed CLI/configuration using this waiver.
CI still executes repository code, so branch protection and review remain necessary.

No deployment, publication, new hosted execution, cloud credentials, live trial,
additional IAM grants, provider mutations or consumed-slot reset is covered. Local
verification must use existing bounded jobs without secrets. The prior failed
lifecycle/partial verdict remains unchanged. Evidence approval for PR #50 is a
separate decision; this proposal does not mark it ready or authorize a merge.

## Required enforcement before activation

The separate implementation must retain the native audit invocation and its full
report. It must distinguish **audit failed with an approved temporary exception**
from **audit clean**. The former may qualify only the eligible documentation PR;
it is not a green security claim or deployment authorization.

- Keep the current native `pnpm audit --audit-level high` command and ordinary
  `pnpm check` behavior. Do not add `--ignore`, lower severity, `|| true`, or
  replace the authoritative audit with a hand-maintained vulnerability list.
- Add a separate documented qualification path consuming the same complete native
  audit result. Require a successful audit exchange and recognized JSON schema;
  reject network errors, malformed/truncated/missing reports and unexpected exit
  status. Match every high/critical finding, including all metadata/dependency paths.
- Require an explicit approved policy record, exact dependency/lockfile bindings,
  eligible full PR diff and current trusted UTC time strictly before expiry.
  An unavailable clock, stale replayed report or incomplete diff fails closed.
- Enforce expiry in CI, not only in prose. Retain raw audit artifacts with the CI
  run identity and current commit; print the advisory, owner, expiry and residual
  failure status in the check summary without credentials.
- Any exception-qualified merge must be distinguishable in review/required checks.
  Owner branch-protection changes require explicit review; do not silently remove
  the existing required verification job to make a failing run mergeable.
- Revoke qualification immediately if a supported patched release becomes available,
  reachability assumptions change, the advisory escalates, or evidence is incomplete.
  Do not silently upgrade a dependency or assume that an upstream release is safe.

These are proposed requirements, not implemented controls or a request to bypass
CI manually. Until they are implemented and approved, all current gates stand.

## Acceptance and removal

Use TDD for enforcement: first show rejection of missing approval, wrong package,
version, advisory, severity or lockfile; extra high/critical findings; audit errors;
non-documentation diffs; stale evidence; and the exact expiry instant. Include a
passing eligible control, pre-expiry boundary, ordinary clean audit, and all existing
floor/recovery checks. Fixture-based qualification tests do not prove the affected
matcher is repaired. Preserve the bounded upstream reproduction for remediation.

Remove the temporary qualification when a compatible fix is verified or at expiry,
whichever is earlier. The owner reviews provenance/changelog, adds failing-first
regression coverage for the selected fix, verifies frozen install with install
scripts blocked, runs the full harness and relevant bundles, and requires the
native audit to pass under the ordinary policy. Record closure in #59. If no fix
exists at expiry, stop qualifying merges; keep the vulnerability and failed audit
visible. No deployment or second live trial follows from removal alone.
