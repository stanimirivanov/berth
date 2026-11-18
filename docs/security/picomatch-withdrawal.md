# Withdrawn advisory reconciliation and exception retirement — #59

## Sources and observed discrepancy

GitHub's [structured advisory](https://api.github.com/advisories/GHSA-fc5q-39xc-vjpf)
records withdrawal at **2026-11-18 15:38:56 UTC**, updated 15:38:58 UTC. The
[advisory page](https://github.com/advisories/GHSA-fc5q-39xc-vjpf) now identifies it
as withdrawn. Its prose explanation is internally inconsistent, so this decision
uses the structured withdrawal field and actual audit outcomes, not an inference
from that sentence.

In the linked [upstream discussion](https://github.com/micromatch/picomatch/pull/235),
the maintainer disputes treating caller-controlled glob expressions as a security
vulnerability and advises against accepting untrusted patterns. The proposed fix
was closed. No patched dependency was installed here: the registry still reports
picomatch **4.0.7**, matching the unchanged lockfile. Withdrawal is not a code fix
and does not invalidate the earlier bounded pathological-pattern reproduction.

Earlier native audit results still listed the high finding after the withdrawal
was visible on GitHub. During reconciliation the unfiltered report changed to
zero high findings. The reason for the timing difference is not established;
feed propagation/caching is a possibility, not proven evidence. No cache clearing,
registry substitution, advisory-ignore option or forced upgrade was used.

Fresh consecutive native observations on November 18, starting at **17:30 UTC**:

| Command | Exit | Counts |
| --- | --- | --- |
| `pnpm audit --audit-level high --json` | 0 | 0 high, 0 critical; 7 moderate, 1 low remain |
| `pnpm audit --json` | 1 | Same counts; nonzero exit is expected when including lower-severity findings |
| `pnpm view picomatch version --json` | 0 | 4.0.7 |

These independent native results meet the existing high-severity threshold. They
do not mean zero vulnerabilities, universal safety of glob patterns, or that the
published withdrawal can be used to override an audit that still fails.

## Removal implemented

CI again runs **unconditional `pnpm check`**. The date selector, conditional
exception-qualified job step and exception artifact upload step are removed. All
other gates, SQL verification, four recovery shards and the final required check
remain. Original package commands and install/dependency policies are unchanged.
The active waiver is removed from CONSTRAINTS.md; there is no renewal or extension.

The historical `check:temporary-audit` and `security:temporary-audit` names are
retained for command compatibility and the existing verification floor. Their
runner supplies **no approval**, labels evidence `exceptionStatus: retired`, and
rejects high/critical findings even if the exact former advisory includes a
withdrawal marker. The pure evaluator retains its former policy branches for historical regression
coverage; no CI/CLI entry point grants their former approval.

The diagnostic evidence also records `nativeRemovalPrerequisiteMet`: true only
when a fresh complete valid native result is clean under the high-severity gate.
It is false for stale high findings, collection/registry errors and malformed
reports. It is a diagnostic prerequisite, not automatic merge/deployment approval
or proof that all repository tests passed. No script edits policy based on a web
page, expiry date or that boolean.

## Failing-first controls

Before retirement, the new stale-withdrawn process case exited 0 by using the
former exception, when the test required failure. The new workflow test also
failed because canonical verification was conditional. After retirement:

- A synthetic stale high finding with `withdrawn_at` still fails; no withdrawal
  property, upstream title or known package version silently suppresses it.
- A native high-threshold result with zero high findings and remaining lower
  findings succeeds when the full report/counts/status agree (native gate 0,
  unfiltered report 1). Lower findings are retained, not erased.
- Missing/invalid reports, registry errors, severe-result drift, unexpected exit
  codes, dirty source and mismatched GitHub event/commit data still fail closed.
- Existing literal test names and recovery tests are retained. The formerly active
  workflow test now verifies retirement and the unchanged legacy command chains;
  a new independent test requires unconditional canonical CI.

## Disposition and operational limits

Issue #59 is resolved as advisory reconciliation and exception retirement, **not**
as an upstream matcher repair. Keep all dated audit/reproduction/approval evidence.
New or reappearing high findings must fail the ordinary gate and receive fresh
triage; do not restore the old approval or revive its November 25 window. Continued
performance caution for untrusted patterns remains valid regardless of audit status.

The OCI trial remains **failed lifecycle / partial feasibility, no-go for rollout**.
Owner closeout is complete. No dependency or lockfile change, cloud credential
read, provider operation, new live trial or consumed-slot reset occurred here.

## Final verification — 2026-11-18

The restored canonical **`pnpm check` passed**: 168 application tests, 30 harness
tests, lint/types, runtime bundle, secret scan and native audit. Only the existing
seven moderate and one low advisory remain; no package or lockfile was changed.
A mutation that inverted removal-readiness metadata failed the process regression;
restoring the correct predicate passed. Commit-time fast gates and final diff
checks cover the final documents. SQL/recovery tests and required job chains are
unchanged; no new live evidence is claimed by these local checks.
