# Temporary verification exception — #62 / PR #63

The owner explicitly requested implementation in PR #63 on **2026-11-18**. This
supersedes the inactive documentation-only proposal for **local and CI verification**.
Expiry is **2026-11-25 00:00 UTC / November 25 02:00 Sofia**. Owner: Stanimir.
Removal issue: #59; upstream review due November 20. This does not remediate the
vulnerability or authorize deployment, publication, grant changes or another trial.
PRs #50/#60 remain drafts; the failed/partial trial verdict and consumed slot remain.

## Commands and evidence

- `pnpm check` and `pnpm run security` keep their original commands and continue to
  fail on the high finding. No native severity threshold or advisory-ignore changes.
- `pnpm run check:temporary-audit` runs the same fast gates, tests, runtime bundle
  and secret scan, then the separate qualified audit. An earlier failure stops
  execution. No `continue-on-error` or blanket failure handler is installed.
- `scripts/temporary-audit.ts` executes `pnpm audit --audit-level high --json` and
  `pnpm audit --json`, once each, bounded to 60 seconds and 4 MiB per response.
  Pnpm filters advisory entries by threshold but reports totals for all severities;
  the unfiltered report is needed to verify complete severity counts. The runner
  requires severe findings and totals to agree across both exchanges, rejecting
  inconsistent results or exit statuses. Both raw results are retained.
- It queries the registry's latest picomatch version. A version other than 4.0.7
  invalidates exception qualification conservatively; it is not assumed patched.
  The advisory publishing a patched range also invalidates qualification. Registry,
  audit, parse, timeout and buffer errors fail closed.
- `evidence.json` retains raw reports, exit statuses, timestamps, current commit,
  CI run identity and classification under RUNNER_TEMP/berth-audit (local fallback:
  system temp). CI uploads this for 14 days. Earlier-stage failure or canonical mode
  produces no exception artifact. Reports contain public dependency metadata;
  runtime/cloud credentials are neither required nor read.

## Qualification

The pure evaluator returns `clean` for the existing high-severity threshold,
`temporary-exception` for a failed native audit satisfying the explicit policy,
or `rejected`. Low/moderate findings remain visible and counted; clean does not
mean zero vulnerabilities. Exception summaries print the native failure, advisory,
owner and expiry and explicitly say this is not an audit-clean result.

Every severe finding must be exactly picomatch 4.0.7, high severity,
GHSA-fc5q-39xc-vjpf, affected range <=4.0.7, no published patch, exact lockfile hash
and all 26 bound public dependency paths exactly once. Additional/missing paths,
other high/critical findings, changed versions, inconsistent counts, malformed
reports, changed lockfile or unexpected status reject qualification.

Fresh reports must be no more than five minutes old, not future-dated and bound to
the current commit. The runner uses its own clock and hardcoded committed owner
approval/expiry; no time/approval CLI override exists. Before expiry CI selects the
qualified full-verification path. At/after expiry it selects the unchanged canonical
command. The runner independently checks the deadline after collection, covering
jobs that cross it. All SQL/recovery jobs and the final required check remain intact.
No branch-protection requirement is removed or renamed.

The current request explicitly broadens scope to verification of code changes,
including this enforcement PR. The runner collects the complete committed Git diff, requiring a clean
checkout, matching GitHub/HEAD commit and an ancestor base from the GitHub event
(or origin/main merge base for local runs). Missing/invalid event data, dirty or
untracked source and Git failures reject qualification. The diff is retained in
evidence; content review remains the owner’s responsibility. The evaluator retains the earlier, stricter documentation-only mode
for callers without verification scope; the committed runner selects verification.
No remote API accepts caller-provided context.

## Trust and removal

The evaluator is a pure function; it cannot authenticate arbitrary caller-provided
approval/time/diff assertions. The committed CI runner supplies those assertions
under the owner-reviewed policy. A local user who controls source/environment can
bypass any local tool; branch protection, normal code review and the committed
workflow remain CI's trust boundary. This exception does not make malicious PR
code safe to execute. Jobs retain read-only repository permissions and no cloud secrets.

New upstream advisory information and reachability changes require manual maintainer
review, due November 20. Registry latest-version checks cannot establish complete
upstream security knowledge. Revoke this verification exception immediately if a
supported fix appears or assumptions change. There is no automatic renewal or grace
period. At expiry the runner rejects; CI uses canonical verification, which remains
blocked until remediation passes the native audit. Keep #59 open until then.

## Tests and verification

Failing-first tests cover verification-scope qualification and process collection.
Policy tests retain missing/altered approval, stale/future evidence, changed digest,
unsafe documentation diffs, malformed metadata, wrong versions/IDs, extra severe
findings and truncated inventories. Exact expiry and one millisecond before expiry
are covered; deliberately weakening >= to > was detected by the boundary test.
Process tests use fake registry/audit executables with real hashing, policy, clock,
clean temporary Git repositories and evidence writes; errors, dirty source and
status drift fail. Workflow tests ensure both paths,
unchanged canonical command, complete temporary gate chain, pinned artifact action,
expiry and absence of continue-on-error. They retain all recovery-shard assertions.

Local qualified full verification passed 165 application tests, 29 harness tests,
bundle and secret scan, then qualified the still-failing native audit. Original
security verification still fails with one high / seven moderate / one low advisory.
No dependency or lockfile changes and no cloud trial were made. These checks prove
the exception mechanism; they do not prove the vulnerable matcher is repaired.

GitHub check statuses do not expire automatically. The timestamp guard applies
when verification runs; it cannot revoke a previously successful run or block an
administrator bypass. The owner must rerun verification before merge and must not
rely on a pre-expiry result after the deadline. No external status-revocation
service, branch-protection change or automatic merge is installed by this PR.
