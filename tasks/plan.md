# Berth application implementation plan

## First release

Build the owner-only, read-only Berth console. **Infrastructure** shows the
supported offerings and which Berth-managed instances may still exist.
**Operation history** uses the Review inbox to explain what needs attention and
to point the owner to the existing procedures. The OCI Object Storage bucket
is the first offering and remains **Trial only · Partial / no-go**. The existing
Angular history screen, private history API, and Cloudflare same-origin proxy
are the starting point.

The release follows [ADR 0006](../docs/adr/0006-land-on-infrastructure-and-link-to-the-review-inbox.md)
and [ADR 0007](../docs/adr/0007-serve-managed-inventory-from-retained-evidence.md).
Provisioning controls, actual usage and cost reporting, allowance displays,
and further live trial work are deferred. Keep the historical partial/no-go
verdict, cleanup reserve and independent owner cleanup procedure. A plan,
implementation merge or readiness result grants no deployment, provisioning
or trial authorization.

GitHub Issues track delivery under the [Read-only Berth application milestone](https://github.com/stanimirivanov/berth/milestone/4).
Create bounded implementation issues with dependencies, acceptance criteria and
focused verification as work is selected. Use TDD for changes in behavior. Run
the affected checks and the canonical `pnpm check:fast` and `pnpm check` gates.

| Milestone | Deliverable | Depends on |
| --- | --- | --- |
| 1. Application shell and Review inbox | Navigable Angular shell and operation detail using the existing history API | Existing history service and proxy |
| 2. Inventory evidence | Resource identity, evidence intake and presence projection proven locally | Existing ledger and ownership rules. Can run in parallel with milestone 1 |
| 3. Infrastructure integration | Catalog and inventory wired through an authenticated read and the Angular landing page | Milestones 1 and 2 |
| 4. Read-only release readiness | Free-plan, access, deployment and rollback readiness decision | Milestone 3 |

### Milestone 1 — Application shell and Review inbox

**Deliverable.** Build the Angular shell with Infrastructure at `/`, Operation
history at `/operations`, and linkable detail at `/operations/:operation`.
Reserve the landing view for the Infrastructure integration in milestone 3.
Reuse the existing list and detail endpoints and the owner's tab-memory access.

**Acceptance criteria**

- The inbox groups the loaded page into **Needs attention** and **Other
  operations**. Detail leads with applicable reasons and owner procedure links
  before showing lifecycle state, execution window, unresolved work and budgets.
- Desktop shows the list and detail side by side. Mobile shows full-width
  detail with a way back. A valid saved link resumes after the token prompt.
  A malformed link makes no history request, and a missing detail keeps the
  list usable.
- List and detail load and retry independently. Failed refreshes retain the
  last successful result with its fetch time and a stale-data warning. A
  failed older-page request leaves the page available with **Retry** and
  **Go to newest**. Access denial clears protected data and pending replies.
- The existing [history API decision](../docs/adr/0005-use-existing-history-api-with-independent-read-states.md)
  continues to govern response fields, access errors and read boundaries.

**Verification.** Extend Chromium coverage for both routes, saved links,
keyboard and narrow-screen navigation, independent pane failures, pagination
and access denial. Run `pnpm build:ui`, `pnpm test:ui` and the focused history
API and proxy tests against local fixtures.

### Milestone 2 — Inventory evidence

**Deliverable.** Define how durable records identify an instance and how the
executor and separately authorized owner procedure can retain provider
observations against that same identity. Implement and test the backend
presence projection before relying on it for the landing page.

**Acceptance criteria**

- Separate instance identity from display name and operation outcome. A create
  or delete with an unresolved result keeps the instance visible as
  **Uncertain** with its reason and any earlier verified observation time.
- Only verified removal for that resource can clear its row. Reject
  mismatched identity and retain the dated evidence, recorded operation
  outcome, expiry and request accounting.
- The projection supplies the latest operation link and the minimal instance
  summary for milestone 3. Historical gaps remain explicit. No history
  outcome, name match or missing evidence becomes a claim of presence or removal.
- Evidence recording stays behind the executor and owner procedure boundaries.
  The inventory read side has no evidence-writing or cloud access.

**Verification.** Run focused unit and disposable PostgreSQL tests for two
instances of the same offering, unresolved create and delete, stale or
mismatched evidence, and resource-specific removal. Exercise the owner
evidence-recording path with local fixtures and verify that the restricted
read role cannot write evidence or read private raw records. Preserve
the existing recovery checks.

### Milestone 3 — Infrastructure integration

**Deliverable.** Connect the Berth-owned catalog and evidence projection to the
Angular landing page through a separate authenticated inventory endpoint.
Use the same-origin proxy boundary for owner access and keep the history
endpoint contract independently testable.

**Acceptance criteria**

- Every supported offering appears, including when it has no known instances.
  Each instance has a name, region, presence status, last verified observation
  when available, an uncertainty reason when applicable, and a **Review
  operation** link. Show uncertain rows first, then sort the rest by display
  name. **Show more**, where needed, keeps existing rows visible.
- Show **No known instances** only after a successful empty read. Keep the
  catalog available during inventory loading and service failures. A failed
  refresh retains previous rows with their fetch time, warning and **Retry**.
  Access denial clears protected state across both screens.
- **Usage**, **Cost**, and **Free-plan headroom** show **Not yet available**.
  Reads trigger no OCI requests and never spend operation cleanup capacity.

**Verification.** Add endpoint and proxy contract tests for authentication,
bounded reads, redaction and regressions to history. Run build and Chromium
checks for the complete Infrastructure-to-operation flow with multiple,
uncertain, removed and empty fixtures, plus stale and denied access states.

### Milestone 4 — Read-only release readiness

**Deliverable.** Record a go/no-go for releasing the read-only console using
the existing Neon and Cloudflare Free targets. A hosted release decision is
separate from the trial feasibility verdict.

**Acceptance criteria**

- Document the release and rollback steps for migrations, the Neon read service,
  the same-origin proxy and the Angular build. Verify configuration separation,
  owner access, restricted database permissions and the direct-upstream
  authentication boundary.
- Establish current Free status and defensible evidence for known allowances.
  Record unavailable Functions usage and apply the reviewed evidence policy
  where it governs. Identify quota interruption risk and any missing evidence
  without claiming a hard spending cap.
- Document when to stop and how to disable access without changing retained
  evidence or owner cleanup. Record a no-go if the access, Free-plan or
  rollback prerequisites cannot be established. Any hosted release requires a
  separate owner approval.

**Verification.** Rehearse the production build, configuration, denied access,
and rollback with local fixtures. Check current plan and usage evidence using
read-only sources and record its scope and observation time. List the hosted
checks for a separately approved release, and distinguish those pending checks
from locally verified results.

## Historical trial plan and evidence

The sections below record prior plans and observations at their original
checkpoints. Their task states and prerequisites are historical. Use GitHub
for current issue status and the linked trial reports for dated evidence.

### Free-plan validation readiness — 2026-11-18

The original trial is closed with a **failed lifecycle / partial-no-go feasibility
verdict**. PRs #50 and #60 are merged; dedicated owner cleanup is complete, including
the compartment's confirmed DELETED state. The dated sections below are historical
planning records, not current activation instructions. Preserve their evidence and
the consumed one-trial exception.

The owner now accepts unavailable Neon Functions usage and quota-induced execution
failure while remaining on Free, including independent owner OCI cleanup if hosted
execution stops. This is agreement to prepare a revised policy, **not authorization
for another live trial**. Existing admission still follows the old contract until
the dedicated policy and implementation changes are reviewed.

#### Outcome and scope

Prepare the existing Neon/Alchemy/OCI stack for a separately reviewed future
validation decision. This milestone ends with a readiness report and offline
recovery evidence. It cannot resolve the remaining live upload/checksum,
metrics/warning, missed-delivery or autonomous-teardown acceptance rows.

No deployments, schedules, account upgrades, credential recreation or live cloud
resource mutations are included. No Angular UI, backend replacement or general
workflow engine is included. Implementation issues use TDD; this planning PR
changes no executable behavior.

#### Decisions and evidence

- Neon documents Functions usage as absent from its Console usage summary;
  consumption API access excludes Free. The earlier correctly parameterized call
  returned 403. Do not request the same unavailable counter again or upgrade for it.
- The official Free-plan policy states no overage billing. Absence of a payment
  method alone does not establish provider behavior. Exact Functions behavior at
  monthly exhaustion remains unverified; do not promise a specific response code,
  delivery guarantee or provider hard spending cap.
- Missing Functions usage remains explicitly unknown. Application accounting and
  forward estimates do not become provider billing totals. Known OCI, Postgres
  and shared network allowances still require defensible fresh evidence.
- Stop new creation if Free status or acceptable billing behavior cannot be
  substantiated, required known allowances are insufficient, or independent
  cleanup cannot be qualified. Missing Functions totals alone is no longer the
  proposed stop condition. Publish a no-go with reasons when a gate fails.
- Preserve 160 normal / 40 cleanup Object Storage requests, attempt limits,
  ownership checks and the original time window. Owner recovery cannot silently
  extend expiry or recreate spent capacity. Retain old SQL evidence and the
  consumed exception; future authorization must be separate.

Sources checked November 18, 2026:
[Console metrics](https://neon.com/docs/introduction/plans#usage-metrics),
[consumption API](https://neon.com/docs/guides/consumption-metrics),
[Free-plan limits](https://github.com/neondatabase/website/blob/main/content/faqs/free-plan-limits-and-quotas.md).

#### Ordered issue index

GitHub Issues are authoritative; there is no duplicate todo checklist.
Milestone: [Free-plan validation readiness](https://github.com/stanimirivanov/berth/milestone/2).

| Issue | Bounded deliverable | Dependency |
| --- | --- | --- |
| [#67](https://github.com/stanimirivanov/berth/issues/67) | Publish this plan and dependent tasks | None |
| [#68](https://github.com/stanimirivanov/berth/issues/68) | Define the revised Functions evidence policy in the specification and quality contract | #67 |
| [#69](https://github.com/stanimirivanov/berth/issues/69) | Enforce the reviewed policy through hosted and SQL admission, using TDD | #68 |
| [#70](https://github.com/stanimirivanov/berth/issues/70) | Qualify independent owner cleanup offline and publish the readiness report | #69 |

Each implementation issue specifies acceptance criteria, focused verification and
likely files, targeting one session and at most five files. Split expanded scope
before implementation. Work is sequential because the evidence contract determines
admission semantics, which determine the final recovery qualification.

#### Checkpoints and completion

After #68/#69, review the contract and negative admission/SQL tests together:
unknown Functions usage must not become fake headroom, stale/paid/unverified
status must not authorize creation, and cleanup must retain its reserved path.
No live activation follows this checkpoint.

After #70, review the offline owner-recovery results, original reserve/expiry
accounting and exact recovery instructions. Run the affected disposable PostgreSQL
suites and canonical repository gates without removing crash coverage. Record
unverified provider behavior and remaining live acceptance rows separately.

Milestone success means a reviewed readiness decision, not a successful resource
lifecycle or a billing measurement. A blocked readiness result is reported as
no-go. Any later live validation requires a separate explicit owner decision,
fresh account/IAM/allowance checks and a new operation authorization; merging these
tasks grants none of those permissions.

#### Risks

| Risk | Mitigation |
| --- | --- |
| Hosted quota exhaustion prevents cleanup | Qualify independent owner recovery; keep reserved capacity and disclose manual intervention |
| Functions usage or exhaustion semantics remain unavailable | Record unknown; retain owner-accepted interruption risk and dated Free-policy evidence |
| Old evidence or consumed exception is reused | Negative admission/SQL tests; separate future operation authorization |
| Offline success is mistaken for live acceptance | Preserve failed/partial historical verdict and explicit unresolved live rows |

### Original trial plan and dated follow-ups

Specification approved by the owner on 2026-11-12. This plan implements only the OCI Object Storage feasibility slice in berth. The toolchain and Neon setup tooling are merged; the owner reports successful Neon database apply/verify. The authenticated hosted synthetic runtime experiment is recorded in docs/trial/runtime-evidence.md. The native Postgres state candidate failed local qualification; see [the blocked decision](../docs/trial/state-decision.md). The [Cloudflare Free follow-up](../docs/trial/cloudflare-state-evidence.md) proved hosted persistence but failed deployment ownership under overlapping writers. The narrow fenced Postgres adapter and hosted #6 feasibility gate subsequently passed; see [the feasibility decision](../docs/trial/feasibility-decision.md). The gated live OCI resource lifecycle remains pending.

### Task tracker

GitHub issues are authoritative for task status, acceptance criteria and verification. Do not create a duplicate tasks/todo.md checklist. [Tracker #1](https://github.com/stanimirivanov/berth/issues/1) contains the approved specification and setup snapshots so remote implementers can work before local documents are published.

### Sequence and checkpoints

1. Establish the toolchain and prepare accounts independently (#2, #3).
2. Prove actual hosted Alchemy execution and durable state (#4, #5); checkpoint #6 must establish feasibility before lifecycle implementation. Do not replace missing capabilities with a paid tier or an unbounded custom engine.
3. Implement the ledger and bucket provider independently against their documented contracts (#7, #8), then the owned object probe (#9), private preview/submission API (#10), hosted continuation (#11), and usage warnings (#12).
4. Complete fault-injection checkpoint #13 before any live OCI resource mutations. Runtime probes before this checkpoint use synthetic resources only.
5. Execute one live trial (#14) and then owner closeout (#15), even if the trial failed. Record a truthful feasibility verdict and leftovers; do not treat a closed setup/task issue as live acceptance.

### Ordered issue index

| Issue | Scope | Dependencies |
|---|---|---|
| [#2](https://github.com/stanimirivanov/berth/issues/2) | Establish the pinned Node 24 trial toolchain | None |
| [#3](https://github.com/stanimirivanov/berth/issues/3) | Prepare Neon Free and the restricted OCI trial identity | None |
| [#18](https://github.com/stanimirivanov/berth/issues/18) | Complete restricted OCI trial identity setup tooling (remaining work after #3 closed) | #2, merged #17; existing OCI tenancy |
| [#4](https://github.com/stanimirivanov/berth/issues/4) | Prove authenticated Alchemy execution in Neon Functions | [#2](https://github.com/stanimirivanov/berth/issues/2), [#3](https://github.com/stanimirivanov/berth/issues/3) |
| [#5](https://github.com/stanimirivanov/berth/issues/5) | Validate a free durable Alchemy state backend | [#4](https://github.com/stanimirivanov/berth/issues/4) |
| [#32](https://github.com/stanimirivanov/berth/issues/32) | Qualify Cloudflare Free durable state from Neon | #5 investigation, owner-confirmed Workers Free |
| [#6](https://github.com/stanimirivanov/berth/issues/6) | Checkpoint: decide whether the Neon and Alchemy trial is feasible | [#5](https://github.com/stanimirivanov/berth/issues/5) |
| [#7](https://github.com/stanimirivanov/berth/issues/7) | Persist trial intent and reserve attempts and request budgets atomically | [#6](https://github.com/stanimirivanov/berth/issues/6) |
| [#8](https://github.com/stanimirivanov/berth/issues/8) | Implement the narrow Alchemy OCI bucket lifecycle | [#6](https://github.com/stanimirivanov/berth/issues/6) |
| [#9](https://github.com/stanimirivanov/berth/issues/9) | Implement the owned 1 MiB object probe and conditional cleanup | [#8](https://github.com/stanimirivanov/berth/issues/8) |
| [#10](https://github.com/stanimirivanov/berth/issues/10) | Expose an authenticated bounded preview and trial submission API | [#7](https://github.com/stanimirivanov/berth/issues/7), [#8](https://github.com/stanimirivanov/berth/issues/8), [#9](https://github.com/stanimirivanov/berth/issues/9) |
| [#11](https://github.com/stanimirivanov/berth/issues/11) | Run bounded trial phases through authenticated scheduled continuation | [#10](https://github.com/stanimirivanov/berth/issues/10), [#4](https://github.com/stanimirivanov/berth/issues/4) |
| [#12](https://github.com/stanimirivanov/berth/issues/12) | Observe bucket usage and record a deduplicated threshold warning | [#11](https://github.com/stanimirivanov/berth/issues/11) |
| [#13](https://github.com/stanimirivanov/berth/issues/13) | Checkpoint: prove recovery and teardown under fault injection | [#12](https://github.com/stanimirivanov/berth/issues/12) |
| [#43](https://github.com/stanimirivanov/berth/issues/43) | Recover interrupted teardown within the fixed cleanup reserve | [#13](https://github.com/stanimirivanov/berth/issues/13) |
| [#14](https://github.com/stanimirivanov/berth/issues/14) | Run the hosted OCI Object Storage trial and record the feasibility verdict | [#13](https://github.com/stanimirivanov/berth/issues/13), [#43](https://github.com/stanimirivanov/berth/issues/43), [#3](https://github.com/stanimirivanov/berth/issues/3) |
| [#15](https://github.com/stanimirivanov/berth/issues/15) | Complete owner-managed trial shutdown and credential revocation | [#14](https://github.com/stanimirivanov/berth/issues/14) |

Dependencies are explicit “Blocked by” references in each GitHub issue body. Issue #15 depends on the live attempt ending, not on a successful verdict. Independent paths may proceed separately but must coordinate shared SDK/dispatcher contracts before integration.

### Diagnostic prerequisite

[#26](https://github.com/stanimirivanov/berth/issues/26): OCI diagnostic tooling and agent-operated verification follows merged #24 / PR #25. It provides bounded read-only checks and live evidence before the remaining hosted implementation; it does not replace #4–#15.

### Architecture and scope

- Node 24 Neon Functions host the private trial API and scheduled continuation; a narrow Alchemy provider owns the OCI bucket lifecycle. No Angular UI is built in this spike.
- A documented free durable Alchemy backend is a feasibility gate, separate from Postgres operation and metrics tables. Runtime must not depend on schema-owner/admin credentials.
- Persist intent, ownership markers and unresolved mutation attempts. Reserve request budgets atomically; do not mistake lease expiry for cancellation of an in-flight OCI request.
- Teardown uses conditional revisions and refuses unknown contents. Scheduled expiry prevents later cloud work; the owner removes the schedule and revokes keys afterward.
- Use strict typed boundaries and focused tests proportional to this trial. Each implementation issue identifies expected files and verification; if new work substantially expands that scope, split it before proceeding.

### Verification and evidence

The first issue establishes executable build/typecheck/focused-test scripts. Until then no such scripts are claimed to exist. Each issue adds tests for its own behavior; checkpoint #13 combines fault scenarios rather than deferring all testing until the end. Checkpoint #6 proves runtime/state feasibility on deployed Neon without OCI mutations. Issue #14 verifies actual OCI IAM, hourly metrics, hosted continuation, controlled recovery and teardown; fake tests cannot satisfy those criteria.

The approved trial limits remain: one bucket and one 1 MiB object; three attempts/action; 200 Object Storage requests split 160 normal/40 cleanup; separate measured Monitoring and Neon budgets; creation ends after 30 minutes, cleanup starts by hour three and cloud work expires at hour four. Cleanup remains available when new-creation preflight fails, subject to its own reserved budget and expiry.

### Risks and open inputs

| Risk/input | Handling |
|---|---|
| Neon Free account/trigger access or restricted-role injection unavailable | #3–#6 report a concrete blocker; no paid fallback. |
| Alchemy runtime/state compatibility unknown | Verify with synthetic resources before OCI mutations; do not equate SDK loading with full support. |
| Current OCI eligibility and aggregate headroom missing | Owner setup evidence in #3, refreshed immediately before #14; compartment metrics remain partial coverage. |
| Metrics arrive too late | Record inconclusive; do not defer scheduled cleanup or invent zero usage. |
| Crash after remote success or resource replacement | #7–#13 cover unresolved attempts, ownership and revision preconditions. |
| Free quota exhaustion or hosted outage during cleanup | Report exact leftovers and manual recovery; no false success. |
| Scheduled no-op use after expiry | Document residual usage and owner removal in #15. |

### Repository documentation

The approved specification, setup guides and this plan are published in the repository.
The tracker retains the original planning snapshots. Use docs/trial/account-readiness.md
for current redacted evidence; a merged tooling PR or closed issue does not establish
live account readiness.

### Fenced adapter follow-up

[#34](https://github.com/stanimirivanov/berth/issues/34) follows the native-store
rejections in #5/#32: narrow owner-installed Postgres functions plus immutable
execution fencing, real SQL fault tests and live Neon persistence evidence.
See docs/trial/fenced-postgres.md. #6 must still integrate and prove hosted execution;
OCI payloads and external side-effect recovery remain separately gated.

Issue #6 integrates the narrow adapter into scheduled Neon Functions and records
its qualification in docs/trial/feasibility-decision.md. The synthetic runtime gate
is separate from current account/headroom attestation and live OCI conditional
mutation/recovery acceptance. Those remain mandatory before enabling OCI writes.

Issue #7 adds the separate operation ledger and atomic dispatch budgets. See
`docs/trial/operation-ledger.md` for lease/unknown-outcome semantics and consumer
obligations. No provider dispatch or live schema installation is included; the
later provider must reserve every request and establish evidence before settlement.

Issue #8 adds the narrow OCI bucket provider with fake-cloud contracts and actual
Alchemy/SDK boundary tests. See `docs/trial/oci-bucket-provider.md`. Ledger dispatch
wiring, durable OCI state payloads and live conditional teardown remain gated;
this implementation does not enable hosted OCI writes.

Issue #9 adds the fixed owned object probe and conditional cleanup. See
`docs/trial/oci-object-probe.md` for persistence ordering, pending-upload recovery
and stop codes. Concrete fenced journal/dispatch wiring and live OCI acceptance
remain gated; offline contracts do not enable cloud writes.

Issue #10 adds private signed preview and atomic ledger submission admission,
with creation-only headroom checks and independent owned-cleanup admission. See
`docs/trial/admission-api.md`; hosted composition, credential-check wiring and the
cleanup executor remain gated follow-up work, not deployed by this API slice.

Readiness inspection after #43 found the live composition missing. Before #14:

- [#46](https://github.com/stanimirivanov/berth/issues/46): wire the real hosted
  executor for a fixed admitted operation, private controls and signed Monitoring.
- [#47](https://github.com/stanimirivanov/berth/issues/47): connect hosted admission,
  meter credential checks and complete deployment/cadence/interruption procedures.

See `docs/trial/live-executor.md`. A locally tested bundle is not a live trial
verdict; #14 stays blocked until these prerequisites and current owner gates pass.

Issue #47 connects signed admission to the prepared live executor. Follow
`docs/trial/hosted-admission.md` for fresh owner gates, activation and shutdown.
The next operational step is #14; local integration is not live acceptance.

### Free Functions evidence qualification

[#52](https://github.com/stanimirivanov/berth/issues/52) records the completed
headroom investigation in [functions-headroom.md](../docs/trial/functions-headroom.md).
Its current-contract verdict is no-go; it includes an explicitly inactive proposal
for an owner-reviewed uncertain one-trial mode. Do not confuse completion of that
investigation with completion of #14, or fill missing live headroom fields with
forward estimates. PR #50 remains draft pending supported evidence or an explicit
contract/implementation revision. No further owner Console search is requested.

### One-trial exception prerequisite — #55

Implement the explicitly accepted Neon Free Functions exception from #52, using a
durable one-use owner preparation and mandatory partial evidence. Preserve all
budgets and recovery coverage. No live activation; #14 / PR #50 remains draft until
reviewed preparation and the actual trial establish the remaining evidence.

### Dependency security hold — #59

[Picomatch assessment](../docs/security/picomatch-triage.md) records the affected
4.0.7 graph, bounded local reproduction and current input-boundary review. No
supported patched release is established on November 18. Preserve the failing
native audit gate; next maintainer review is November 20. #59 stays open for actual
remediation. PRs #50/#60 stay draft; no live activation or exception reset.

### Offline exception qualification — #62

Implement the pure [audit evaluator](../docs/security/audit-exception-evaluator.md)
with failing-first controls. Approval acquisition, trusted CI evidence, content
review and activation remain a separate PR-sized task. No audit/CI bypass is
installed; #59 remains open and PRs #50/#60 remain draft.

### Owner-requested activation in PR #63

The owner requested the time-limited verification exception on November 18.
The implemented separate check path qualifies only the bound picomatch finding
until November 25 00:00 UTC and retains native audit failure/report evidence.
This supersedes #62's earlier inactive scope; canonical audit and recovery gates
remain unchanged. #59 remains open; no deployment or new trial is authorized.

### Offline SDK lifecycle follow-up — #64

[Offline SDK proof](../docs/trial/offline-sdk-lifecycle.md) covers the complete
bucket/object helper journey through the real pinned SDK and an independent HTTP
model, with unsafe-response controls and original 160/40 ceilings. It changes no
production code and cannot replace the partial live verdict. PRs #50/#60 were
rebased, evidence preserved and kept draft; no new live run is authorized.
### Remaining live activation prerequisites after PR #50 preflight

Owner account/activity questions are answered; do not repeat unavailable Console
meter requests. Complete these bounded engineering tasks before #14 activation:

- [#51](https://github.com/stanimirivanov/berth/issues/51): make complete recovery CI
  reliable within existing limits, preserving all crash boundaries and assertions.
- [#52](https://github.com/stanimirivanov/berth/issues/52): qualify Functions headroom
  evidence on Free. Any evidence-contract change requires explicit review before use.

The tasks are independent. Resume #14 only after both gates are satisfied; follow
with #15 owner closeout. No paid fallback or weakening of the trial bounds.
### Live trial result — 2026-11-15

#14 used the approved exception once and recorded a partial/no-go verdict in PR
#50. Hosted bucket creation succeeded; an omitted optional OCI metadata field
blocked upload. Owner recovery removed the bucket within the original cleanup
reserve, then deleted hosting and revoked the trial key. No live metrics/warning
or controlled-interruption pass is claimed.

- [#57](https://github.com/stanimirivanov/berth/issues/57): explicitly request
  auto-tiering metadata, with failing-first provider contract tests; preserve all
  ownership and recovery checks. Code-only scope, no new live activation.
- #15: review/complete owner closeout and retained evidence after the failed run.

PR #50 remains draft. The one-use exception stays consumed; a corrected adapter
alone cannot authorize another trial or change this partial verdict.
### Owner closeout — #15, 2026-11-18

[Owner closeout](../docs/trial/owner-closeout.md) records fresh empty hosting/resource
inventories, revoked trial key, retained failed/partial SQL evidence and no recorded
post-expiry work. Dedicated policy/group/user deletion succeeded; the empty OCI
compartment entered asynchronous DELETING. Residual provider-billed invocation usage
remains unknown. PR #50 stays draft and the consumed exception is preserved.

### Picomatch exception retired — #59, 2026-11-18

[Reconciliation](../docs/security/picomatch-withdrawal.md) records the upstream
withdrawal, the initially differing native reports and fresh high-threshold exit 0.
CI returns to unconditional canonical verification; no dependency waiver remains.
Stale high findings still fail, and seven moderate / one low finding remain visible.
This closes dependency triage without changing the failed/partial trial verdict
or authorizing another live run. Earlier active-exception entries are historical.

### Free-plan readiness qualification — #70, 2026-11-19

[Readiness report](../docs/trial/free-plan-readiness.md) and
[independent owner procedure](../docs/trial/owner-recovery.md) complete the bounded
offline preparation milestone after #68/#69. The existing executor with real SDK
wire behavior and local SQL qualifies clean/lost-DELETE owner recovery within the
unchanged reserve; unsafe, uncertain, exhausted, expired or unreadable work stops.
The failed/partial live verdict and consumed authorization remain intact. A future
live validation proposal needs a separate explicit owner decision and fresh account
checks; no deployment or new trial is authorized by this milestone.

### Read-only live readiness — #75, 2026-11-19

[#75](https://github.com/stanimirivanov/berth/issues/75) records the
[authenticated readiness assessment](../docs/trial/live-readiness-75.md): Neon Free
and empty hosting are verified; old failed/partial evidence and deleted OCI
compartment remain unchanged. Migration 006 is not installed. Current OCI account
type, complete known allowance evidence, replacement restricted access and a new
owner-authorized operation/window remain prerequisites.

[#76](https://github.com/stanimirivanov/berth/issues/76) is the separately blocked
bounded live-validation task, dependent on #75's missing prerequisites and explicit
owner authorization. Closing the assessment or merging its PR authorizes no
provisioning, deployment, migration installation or live trial. All cleanup/time
bounds and historical evidence are preserved.


### One-hour partial live result — #76, 2026-11-20

[Issue #76](https://github.com/stanimirivanov/berth/issues/76) was explicitly
approved for a one-hour-supervised experiment under the merged #78 policy. The
[separate live result](../docs/trial/live76-results.md) records hosted bucket creation,
an unresolved PUT, stopped hosted/owner cleanup, verified hosting removal and a
retained restricted key. The new operation remains **needs-reconciliation** with
**26/40 cleanup requests left**, and its original **12:50 Sofia November 20**
cloud-work expiry. It is not closed or renewed; historical failure/partial evidence
and completed old closeout remain unchanged.

- [#80](https://github.com/stanimirivanov/berth/issues/80): bounded TDD fix for empty
  POST stream handling on hosted controls; no deployment/live work authorized.
- [#81](https://github.com/stanimirivanov/berth/issues/81): reproduce/diagnose the
  hosted PUT failure and add safe transport/bundle regression evidence; no guessed
  settlement, live-state changes or new trial authorized.

Further owner reconciliation must review the retained request/ownership evidence
and existing reserve/window before any mutation. Metrics, checksum, missed-delivery
recovery and complete teardown remain unproven; overall feasibility stays partial/no-go.

### Expired-trial reconciliation — #83, 2026-11-20

[Read-only owner reconciliation](../docs/trial/reconciliation83.md) confirms the
saved bucket still exists with matching ownership/revision and empty complete
inventories. The dedicated key remains registered; hosting remains absent. SQL
requests, attempts, state, immutable authorizations and counters are unchanged;
the original window has expired and **26/40 cleanup requests remain historical**.

The report supplies a bounded, conditional after-expiry owner closeout proposal.
It requires a separate explicit decision; this read-only issue does not authorize
mutation, clear the unresolved PUT, restart the executor or start another trial.
#76 remains unresolved/partial; #81 and #80 remain the implementation follow-ups.
