# Berth quality contract

These controls apply to the existing trial. Proposed changes to their scope or
strength need explicit review in a dedicated issue/PR; never add a silent bypass.

| Control | Required result | Sensor |
| --- | --- | --- |
| Formatting and types | Zero diagnostics; strict application and checkJs harness projects | `pnpm lint`, `pnpm typecheck` |
| Function spacing | Blank lines before/after function declarations and before their leading documentation | `pnpm lint:spacing` |
| Trial/tool contracts | Attached prose JSDoc/TSDoc on public declarations, types, methods and named helpers of at least six lines | `pnpm harness` |
| Runtime ownership | Closed module/package imports; no hosted/admin coupling, CommonJS/dynamic loaders or runtime cycles | `pnpm harness` |
| Verification integrity | No suppression comments or disabled/focused tests; baseline literal test-name counts preserved | `pnpm harness`, `pnpm floor` |
| Existing commands | Original command retained; only additional namespaced check chains admitted | `pnpm floor` |
| Private indexed material | No credential paths, keys or private-prefixed components | `pnpm harness` |
| Secrets | Zero Gitleaks findings in worktree, index and locally available history; tool/report failures fail | `pnpm secrets` |
| Dependencies | No reported high/critical advisories; lower findings still reviewed | `pnpm security` |
| Behavior and packaging | All local suites and official Neon bundle build succeed | `pnpm test`, `pnpm build:runtime-probe` |
| SQL boundary | Fresh loopback database permission and drift tests pass | CI `pnpm test:setup-db` |

No coverage percentage is invented for unmeasured code. Legacy scripts need a
reviewed documentation backfill before widening the documentation gate. Those gaps
are explicit in HARNESS.md. Existing commands and tests are preserved; this contract
does not authorize weakening the approved SPEC.md resource/request/time budgets.

Exceptions must identify scope, reason, owner, removal issue and expiry. A prose
exception does not bypass a check: a deliberate policy revision and owner review
are required. External branch protection is necessary to make CI merge-blocking.

The historical owner-approved #55 Functions-evidence exception is limited to the single
operation/window defined in SPEC.md. It changes only the unknown Functions
headroom gate and requires a partial verdict. Resource/request/time limits and all
verification controls remain. The owner closes it under #14; authorization expires
with that four-hour window and cannot be reset after success or failure.
It was consumed by the failed November 15 trial; keep its authorization and evidence.

## Revised Functions evidence contract — #68, 2026-11-19

SPEC.md defines the owner-accepted future policy: missing Functions totals may
remain unknown on verified Neon Free, with explicit acceptance of interruption
and independent owner cleanup. This documentation changes no admission behavior.
Issue #69 must enforce it in both hosted and SQL admission; #70 must qualify owner
recovery offline. A separate explicit owner decision is required for any future
deployment/trial. The current milestone grants no such authorization.

- Free status and dated provider billing policy are evidence, not inferred from
  absent payment details. Unknown/paid/stale status or unsupported acceptable billing
  behavior blocks creation. Known OCI, Postgres and shared-transfer allowance checks
  remain mandatory; missing Functions totals alone is the only relaxed evidence gate.
- Preserve unknown values, source/coverage labels and `hardSpendingCap=false`.
  No fabricated quota, request-ledger billing proxy or automatic feasibility pass.
  Known exhausted Functions allowance still blocks creation.
- Bind future authorization to a distinct operation/window, policy and reviewed
  evidence. Preserve the consumed #55 record; reject replay and client/SQL bypass.
- Preserve every resource/request/attempt/time/ownership control, including the
  160/40 split, reserved cleanup and independently executable owner recovery.
  Creation evidence failure must not remove owned cleanup; cleanup cannot bypass
  its own reserve or expiry. Retain leftovers for explicit owner reconciliation.
- Report capability evidence separately; unknown Functions allowance requires an
  overall partial verdict. Preserve the historical failed/partial-no-go evidence.

This policy does not relax tests, audit, secret scanning or other quality gates.

## Single-operation allowance exception — #78, 2026-11-19

The owner-approved issue-76 extension permits only the five incomplete meters named
in SPEC.md. Its optional `issue76-once-v1` evidence record must be explicit and
durably bound once to the owner-approved operation/window/identity and snapshot.
Unknown concurrent activity/quota interruption must be accepted; no invented
remaining capacity or silent unit conversion is permitted. Known insufficiency
still rejects, including where partial observed consumption already exceeds the
reviewed Free allowance after the required envelope is reserved.

Fresh eligibility/IAM/billing evidence and known storage/Postgres capacity remain
mandatory. Preserve all local budgets, protected cleanup, recovery coverage and
expiry rules. Monitoring HTTP calls and billing datapoints remain separate units.
Default strict admission and prior authorization records are unchanged; the new
singleton is immutable and cannot be reused after any outcome. Runtime SQL/HTTP
cannot prepare it or bypass its binding. Reports remain partial independently of
lifecycle success and mutable evidence. No cloud writes or live authority are
granted by merging this policy. Canonical verification and audit gates remain.

The picomatch verification exception from PR #63 was retired under #59 on
2026-11-18 after the unchanged native high-severity gate returned clean results.
There is no active dependency exception. CI runs unconditional `pnpm check`;
legacy diagnostic commands retain their names but supply no approval and reject
any remaining high/critical finding, including stale withdrawn advisory entries.
No withdrawal flag is an audit suppression. See docs/security/picomatch-withdrawal.md.
