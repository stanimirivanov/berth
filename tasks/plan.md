# OCI Object Storage trial implementation plan

Specification approved by the owner on 2026-11-12. This plan implements only the OCI Object Storage feasibility slice in berth. The toolchain and Neon setup tooling are merged; the owner reports successful Neon database apply/verify. The authenticated hosted synthetic runtime experiment is recorded in docs/trial/runtime-evidence.md. The native Postgres state candidate failed local qualification; see [the blocked decision](../docs/trial/state-decision.md). No durable backend is approved. The #6 feasibility gate and gated live OCI resource lifecycle remain pending.

## Task tracker

GitHub issues are authoritative for task status, acceptance criteria and verification. Do not create a duplicate tasks/todo.md checklist. [Tracker #1](https://github.com/stanimirivanov/berth/issues/1) contains the approved specification and setup snapshots so remote implementers can work before local documents are published.

## Sequence and checkpoints

1. Establish the toolchain and prepare accounts independently (#2, #3).
2. Prove actual hosted Alchemy execution and durable state (#4, #5); checkpoint #6 must establish feasibility before lifecycle implementation. Do not replace missing capabilities with a paid tier or an unbounded custom engine.
3. Implement the ledger and bucket provider independently against their documented contracts (#7, #8), then the owned object probe (#9), private preview/submission API (#10), hosted continuation (#11), and usage warnings (#12).
4. Complete fault-injection checkpoint #13 before any live OCI resource mutations. Runtime probes before this checkpoint use synthetic resources only.
5. Execute one live trial (#14) and then owner closeout (#15), even if the trial failed. Record a truthful feasibility verdict and leftovers; do not treat a closed setup/task issue as live acceptance.

## Ordered issue index

| Issue | Scope | Dependencies |
|---|---|---|
| [#2](https://github.com/stanimirivanov/berth/issues/2) | Establish the pinned Node 24 trial toolchain | None |
| [#3](https://github.com/stanimirivanov/berth/issues/3) | Prepare Neon Free and the restricted OCI trial identity | None |
| [#18](https://github.com/stanimirivanov/berth/issues/18) | Complete restricted OCI trial identity setup tooling (remaining work after #3 closed) | #2, merged #17; existing OCI tenancy |
| [#4](https://github.com/stanimirivanov/berth/issues/4) | Prove authenticated Alchemy execution in Neon Functions | [#2](https://github.com/stanimirivanov/berth/issues/2), [#3](https://github.com/stanimirivanov/berth/issues/3) |
| [#5](https://github.com/stanimirivanov/berth/issues/5) | Validate a free durable Alchemy state backend | [#4](https://github.com/stanimirivanov/berth/issues/4) |
| [#6](https://github.com/stanimirivanov/berth/issues/6) | Checkpoint: decide whether the Neon and Alchemy trial is feasible | [#5](https://github.com/stanimirivanov/berth/issues/5) |
| [#7](https://github.com/stanimirivanov/berth/issues/7) | Persist trial intent and reserve attempts and request budgets atomically | [#6](https://github.com/stanimirivanov/berth/issues/6) |
| [#8](https://github.com/stanimirivanov/berth/issues/8) | Implement the narrow Alchemy OCI bucket lifecycle | [#6](https://github.com/stanimirivanov/berth/issues/6) |
| [#9](https://github.com/stanimirivanov/berth/issues/9) | Implement the owned 1 MiB object probe and conditional cleanup | [#8](https://github.com/stanimirivanov/berth/issues/8) |
| [#10](https://github.com/stanimirivanov/berth/issues/10) | Expose an authenticated bounded preview and trial submission API | [#7](https://github.com/stanimirivanov/berth/issues/7), [#8](https://github.com/stanimirivanov/berth/issues/8), [#9](https://github.com/stanimirivanov/berth/issues/9) |
| [#11](https://github.com/stanimirivanov/berth/issues/11) | Run bounded trial phases through authenticated scheduled continuation | [#10](https://github.com/stanimirivanov/berth/issues/10), [#4](https://github.com/stanimirivanov/berth/issues/4) |
| [#12](https://github.com/stanimirivanov/berth/issues/12) | Observe bucket usage and record a deduplicated threshold warning | [#11](https://github.com/stanimirivanov/berth/issues/11) |
| [#13](https://github.com/stanimirivanov/berth/issues/13) | Checkpoint: prove recovery and teardown under fault injection | [#12](https://github.com/stanimirivanov/berth/issues/12) |
| [#14](https://github.com/stanimirivanov/berth/issues/14) | Run the hosted OCI Object Storage trial and record the feasibility verdict | [#13](https://github.com/stanimirivanov/berth/issues/13), [#3](https://github.com/stanimirivanov/berth/issues/3) |
| [#15](https://github.com/stanimirivanov/berth/issues/15) | Complete owner-managed trial shutdown and credential revocation | [#14](https://github.com/stanimirivanov/berth/issues/14) |

Dependencies are explicit “Blocked by” references in each GitHub issue body. Issue #15 depends on the live attempt ending, not on a successful verdict. Independent paths may proceed separately but must coordinate shared SDK/dispatcher contracts before integration.

## Diagnostic prerequisite

[#26](https://github.com/stanimirivanov/berth/issues/26): OCI diagnostic tooling and agent-operated verification follows merged #24 / PR #25. It provides bounded read-only checks and live evidence before the remaining hosted implementation; it does not replace #4–#15.

## Architecture and scope

- Node 24 Neon Functions host the private trial API and scheduled continuation; a narrow Alchemy provider owns the OCI bucket lifecycle. No Angular UI is built in this spike.
- A documented free durable Alchemy backend is a feasibility gate, separate from Postgres operation and metrics tables. Runtime must not depend on schema-owner/admin credentials.
- Persist intent, ownership markers and unresolved mutation attempts. Reserve request budgets atomically; do not mistake lease expiry for cancellation of an in-flight OCI request.
- Teardown uses conditional revisions and refuses unknown contents. Scheduled expiry prevents later cloud work; the owner removes the schedule and revokes keys afterward.
- Use strict typed boundaries and focused tests proportional to this trial. Each implementation issue identifies expected files and verification; if new work substantially expands that scope, split it before proceeding.

## Verification and evidence

The first issue establishes executable build/typecheck/focused-test scripts. Until then no such scripts are claimed to exist. Each issue adds tests for its own behavior; checkpoint #13 combines fault scenarios rather than deferring all testing until the end. Checkpoint #6 proves runtime/state feasibility on deployed Neon without OCI mutations. Issue #14 verifies actual OCI IAM, hourly metrics, hosted continuation, controlled recovery and teardown; fake tests cannot satisfy those criteria.

The approved trial limits remain: one bucket and one 1 MiB object; three attempts/action; 200 Object Storage requests split 160 normal/40 cleanup; separate measured Monitoring and Neon budgets; creation ends after 30 minutes, cleanup starts by hour three and cloud work expires at hour four. Cleanup remains available when new-creation preflight fails, subject to its own reserved budget and expiry.

## Risks and open inputs

| Risk/input | Handling |
|---|---|
| Neon Free account/trigger access or restricted-role injection unavailable | #3–#6 report a concrete blocker; no paid fallback. |
| Alchemy runtime/state compatibility unknown | Verify with synthetic resources before OCI mutations; do not equate SDK loading with full support. |
| Current OCI eligibility and aggregate headroom missing | Owner setup evidence in #3, refreshed immediately before #14; compartment metrics remain partial coverage. |
| Metrics arrive too late | Record inconclusive; do not defer scheduled cleanup or invent zero usage. |
| Crash after remote success or resource replacement | #7–#13 cover unresolved attempts, ownership and revision preconditions. |
| Free quota exhaustion or hosted outage during cleanup | Report exact leftovers and manual recovery; no false success. |
| Scheduled no-op use after expiry | Document residual usage and owner removal in #15. |

## Repository documentation

The approved specification, setup guides and this plan are published in the repository.
The tracker retains the original planning snapshots. Use docs/trial/account-readiness.md
for current redacted evidence; a merged tooling PR or closed issue does not establish
live account readiness.
