# Pre-live recovery checkpoint — issues #13 and #43

This checkpoint uses real PostgreSQL, the pinned Alchemy engine, real Node
process termination and a deterministic fake OCI service. It makes **no live OCI
claim**. Issue #14 still requires the live permissions, metrics, allowance and
hosted teardown evidence below. Do not enable a live schedule based on unit tests.

## Reproduce

- Use the pinned Node/pnpm toolchain and install with `pnpm install --frozen-lockfile`.
- Start a fresh disposable PostgreSQL 17 on loopback using the same digest as CI,
  database `neondb`, user `postgres`, test-only password `berth-test-only`.
- Set `BERTH_TEST_POSTGRES_PORT` to its mapped loopback port.
- Run `pnpm run test:setup-db` once to install the restricted fixture login.
- Run `pnpm run test:recovery-db`. It installs and drops schemas for each case;
  never point it at an existing development database or run other integration
  suites against the same instance concurrently.
- Run `pnpm run test:ledger-db`, `pnpm run test:executor-db` and
  `pnpm run test:usage-db` sequentially, then `pnpm check` and
  `pnpm run build:executor`.
- Stop the disposable database. No cloud account or credential files are needed.

## Fault inventory and limits

Seed `13` uses a fixed operation ID and delivery sequence. Database-generated
ownership tokens vary; no assertion depends on their literal value. Each baseline
trajectory records semantic boundary labels and invocation-local occurrence
numbers. The sweep reproduces the first occurrence of each label and asserts that
SIGKILL occurred at exactly that boundary. It is not an exhaustive permutation of
repeated reads, arbitrary SQL instructions or concurrent network schedules.

The trajectories are successful creation/upload/observation/cancellation/teardown,
lost success responses for all four mutations, and definite create/upload
rejection. A separate sweep interrupts read-only recovery and the
`not-dispatched` settlement after the local creation deadline crosses. Boundaries include before/after committed executor checkpoints, Alchemy
state, ledger attempt/reservation/settlement, usage persistence and provider
mutations. Separate ledger tests terminate a PostgreSQL backend around transaction
commit. Unknown SQL in the child fails classification rather than silently being
excluded. Reads, parent-owned fixture setup and the earlier intent-creation tests
are outside the child write sweep.

The provider lives in the parent process behind loopback HTTP. It survives child
SIGKILL and can accept a request, allow a new owner to observe absence, and only
then complete the old request while its executor is still alive. This tests late
completion, not provider persistence across host power loss. The parent advances
lease expiry and observation eligibility through fixture-only owner SQL; this is
not evidence of a four-hour hosted soak.

Each dispatch must have a unique committed unresolved reservation with the same
action, generation and meter. This includes reads and each Monitoring request.
Reservations may outnumber dispatches after a crash; counters must equal committed
reservations. Every case checks attempts, all four budgets, provider state,
unresolved mutations and the single-active-trial lock. Safe unresolved cases must
retain uncertainty and block another trial; they are not reported as successful
teardown. Responses carry a private canary which must not reach child output. Actual
PUT/GET bytes cross the fixture boundary with bounded base64 encoding; a corrupted
stored-object case proves that a matching checksum is not manufactured. Unexpected
child failures and unknown SQL classification fail the test rather than becoming
successful stops.

## Acceptance matrix

| SPEC row | Non-live status and evidence | Live status and evidence still required |
| --- | --- | --- |
| Runtime | **PASS (bounded fixtures).** Real Alchemy in child processes; SQL state persists across SIGKILL. Prior hosted synthetic evidence remains separate. | **BLOCKED: not run in this checkpoint.** Deployed OCI composition and SDK execution without the owner's computer. |
| Permissions | **PASS (bounded fixtures).** Admission/scheduler negative tests; runtime startup catalog guard rejects administrator, role membership, schema, direct table and column grants. | **BLOCKED: not run in this checkpoint.** Effective OCI IAM review and real permitted/denied actions. |
| Preview | **PASS (bounded fixtures).** Preflight and API fixtures reject unknown/stale allowances and unsupported settings; exact signed proposal makes no provider writes. | **BLOCKED: not run in this checkpoint.** Fresh owner-attested aggregate allowance headroom. |
| Lifecycle | **PASS (bounded fixtures).** Alchemy bucket lifecycle, deterministic 1 MiB checksum, no duplicate mutation in crash sweep; create-only and revision-bound real SDK serialization tests. | **BLOCKED: not run in this checkpoint.** Real bucket settings, upload/checksum and persisted identity. |
| Usage | **PASS (bounded fixtures).** Three separately reserved requests, malformed/stale/missing samples remain unknown; hourly SQL cadence and retained observations. | **BLOCKED: not run in this checkpoint.** Fresh bucket-filtered OCI metrics with source timestamps. |
| Warning | **PASS (bounded fixtures).** Equality at 50% of 2 MiB warns once; SQL deduplicates and retains history after cleanup. | **BLOCKED: not run in this checkpoint.** Actual post-upload threshold observation. |
| Recovery | **PASS (bounded fixtures).** 136 primary semantic boundaries plus four recovery-only boundaries; all three pre-delete interruptions from #43 now require terminal teardown within 40 requests. | **BLOCKED: not run in this checkpoint.** Hosted continuation and recovery under deployed limits. |
| Teardown | **PASS (bounded fixtures).** Conditional revision tests preserve replacements; protected cleanup after normal-budget exhaustion; auth errors and incomplete inventory cannot prove absence. | **BLOCKED: not run in this checkpoint.** Owned object/bucket removal with authenticated absence evidence. |
| Outcome | **PASS (bounded fixtures).** Terminal assertions require no unresolved mutation and empty fake cloud; unknown requests preserve the active slot. | **BLOCKED: not run in this checkpoint.** Dated allowance delta, durable hosted outcome and owner shutdown evidence (#15). |

The database privilege check is a startup drift detector, not a defence against a
malicious administrator changing grants after it runs. The SQL owner remains a
trusted installation boundary. These checks do not grant runtime migration rights.

## Gate verdict

**The local cleanup-reserve blocker from [issue #43](https://github.com/stanimirivanov/berth/issues/43) is resolved by this change.**
Live qualification still requires issue #14's account, IAM, metrics and hosted
execution evidence; this local result does not enable a schedule or cloud writes.

Previously, crashes at `before:ledger.begin:delete_object`,
`after:ledger.begin:delete_object`, or `before:ledger.reserve:delete_object`
exhausted 40 cleanup requests after deleting the object, leaving the bucket.
The regression first reproduced that failure, then required terminal status,
zero unresolved mutations, exactly one deletion of each resource and an empty
cloud model within the unchanged reserve.

The fix defers the first bucket check until after the read-only object inventory,
checksum and reconciliation callback. A full fresh ownership/configuration and
inventory check still gates DELETE. Empty inventories still require saved bucket
identity before returning. No inspection results are cached across invocations,
reservations refunded or conditional-delete checks removed.

Ten other primary checkpoints correctly retain one genuinely uncertain mutation:
`after:ledger.reserve:<action>` / `before:cloud.<method>` for each of the four
mutations, and interruption before recording a definite create/upload rejection.
The ten require owner reconciliation; a response lost before durable settlement is
not evidence of rejection. All remaining 126 primary checkpoints must reach terminal
with no unresolved mutations or leftover cloud resources. An unexpected child
exception, unclassified SQL or new recovery stop fails the suite.

Verification covers the 136 primary cases, four recovery-only cases, three
explicit interrupted-delete regressions, delayed completion, corruption and DB
privilege checks. Use
`BERTH_RECOVERY_POINT=before:ledger.begin:delete_object pnpm run test:recovery-db`
for a focused reproduction; omit the variable for the full CI gate. Unknown labels
fail. This filter does not claim full-checkpoint coverage.

Missing metrics, unknown dispatches and fixture-only results never become a live pass.

## Review and verification

The independent design review identified privilege drift, missing concurrent late
completion, recovery-only writes and per-request accounting gaps. The implementation
adds focused checks for each. The separately authorized read-only Codex CLI review
identified permissive exception handling and substituted object bytes in the first
fixture version; both findings were accepted and corrected. The CLI review used no
cloud credentials, deployments or database access. No second CLI review is claimed.

The issue #13 `pnpm check` passed 129 application tests and 22 harness tests, including formatting,
strict types, ownership/documentation checks, bundle build and secret scan. The
unchanged dependency audit has seven moderate and one low finding, with no
high/critical finding. `pnpm run build:executor` also passes. These checks do not
replace the database-suite and live acceptance evidence.

Issue #43 adds post-checksum drift tests for bucket ID/marker/configuration,
retention, access grants, version history, unexpected contents, multipart uploads
and pagination, plus an empty-inventory ownership test. Replacement-safe deletion,
lost-upload cleanup after normal-budget exhaustion and all ten ambiguous dispatch
expectations remain unchanged. Review of this change is separate from the earlier
CLI review; no additional external CLI review was run.

Issue #43 verification on 2026-11-14: `pnpm check:fast`, `pnpm check` (131 application
and 22 harness tests), the executor bundle, 28 provider contracts, and ledger (5),
executor (11), usage (6) and privilege suites passed. The three interrupted-delete
regressions first failed at 40 requests with the bucket remaining, then passed
with one object deletion, one bucket deletion, no unresolved mutations and
35 of the unchanged 40 cleanup requests used in each case.

**Execution limitation:** an uninterrupted local `test:recovery-db` run did not
finish: the first was interrupted after 131 primary checkpoints; the retry reached
the unchanged 600-second wall-clock limit under competing host CPU load. The five
remaining primary checkpoints and all auxiliary scenarios passed in focused runs,
with the existing assertions intact. All 136 primary checkpoints are covered across
those runs; this is not a claim that the full command exited successfully. CI still
runs the unfiltered command. An isolated build-copy mutation of the new empty-
inventory branch caused its ownership test to fail; the real build was unchanged.
