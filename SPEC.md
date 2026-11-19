# OCI Object Storage on Neon feasibility trial

Originally approved for implementation planning, 2026-11-12. Current status:
the November 15 live lifecycle failed and feasibility remains **partial / no-go**;
owner closeout is complete. Dated proposal/setup text below describes the original
trial. The November 19 evidence policy defines future requirements only; no new
live trial is authorized.

## Objective

Prove Alchemy can manage one private OCI Standard Object Storage bucket from Neon Free: preview, create, inspect, measure usage, warn, recover after interruption and delete. Operations must continue without the initiating computer online. This is one feasibility slice, not the complete product specification.

Confirmed constraints: single user; free plans only; eventual Angular + NgRx Signal Store + Effect frontend on Cloudflare; Neon replaces Supabase only after a successful trial. Existing cloud-infra remains untouched. No paid fallback or promotional-credit dependency.

Assumptions: dedicated empty compartment in the OCI home region; one 1 MiB object; Oracle-managed encryption; no versioning, retention, replication, public access or multipart upload. A private API client suffices for the runtime spike; the Angular journey follows feasibility. Initial account and IAM bootstrap is an owner action, separate from hosted resource operations.

## Setup

Follow [Account setup and permissions](docs/oci-neon-setup.md). No cloud writes have occurred. Actual account type, home region and headroom remain to be supplied. Secrets must never appear in source, operation payloads, persisted IaC state, responses or logs. The proposed server-side environment variables are trial bootstrap, not a completed product credential vault.

## Runtime proposal and uncertainties

Use Node.js 24 Neon Functions with a narrow Alchemy custom OCI bucket provider. No first-party OCI provider was found in the reviewed documentation. Validate the actual pinned Alchemy package and OCI SDK in the deployed runtime before implementing the full lifecycle.

Durable Alchemy state must survive fresh invocations. Evaluate documented remote stores first; do not assume Neon Postgres is an existing supported Alchemy backend. A custom store requires explicit assessment of scope and concurrency semantics. Postgres operation records and metrics are separate from IaC state.

Neon Functions are not a job queue. Proposed continuation is an authenticated scheduled invocation claiming bounded pending work. Persist intent before mutations; use stable operation IDs and deterministic resource names, exclusive renewable leases and generation checks. Reconcile OCI before every retry. A local lease/generation check cannot fence an OCI call already in flight. Persist each mutation attempt before dispatch, including its identity, start time and unresolved outcome. Lease expiry or client timeout must not clear an unresolved attempt. Do not start competing mutations or declare teardown complete while an earlier create could still finish. Discover late-created resources through subsequent hosted reconciliation. If provider completion cannot be established within the trial window, retain needs-reconciliation and report potential leftovers; an absence check alone is insufficient. Stop and revisit feasibility if this demands a general-purpose workflow engine.

Authenticate manual endpoints and verify Neon's scheduled-trigger authenticity. Request data cannot select arbitrary compartments or actions. Do not expose a static trial token in a public UI. Initial deployment credentials must not be available to the execution function.

## Ownership and conditional mutations

Before creation, persist a random run marker, expected target, deterministic names and intended content digest. Attach the marker to the bucket's free-form tags and the object's metadata at creation. Record provider bucket identity and ETags on observation. Reconciliation requires matching precommitted intent, marker and configuration, plus previously observed provider identity where available; names or checksums alone do not establish ownership. A pre-existing name with absent/conflicting evidence is never adopted. Markers protect against accidental collisions, not a malicious account administrator; the trial compartment is reserved against concurrent owner writes.

Use a create-only precondition for the object. Inspect marker and content against a consistent object revision, then delete with the inspected ETag as an If-Match precondition. Use the bucket revision precondition for bucket deletion as supported by the pinned SDK, and rely on the provider's nonempty-bucket rejection. Precondition failures stop deletion for reconciliation, never retry unconditionally. Verify these API semantics before live mutations; unsupported conditional behavior blocks automated deletion rather than weakening ownership checks.

## Proposed trial bounds

- One active trial, one bucket, one 1 MiB object. No automatic adoption of pre-existing names.
- Maximum three attempts per action with bounded backoff and a 200-request Object Storage budget: 160 for setup/probes/permission tests/lifecycle and 40 exclusively for cleanup/reconciliation/absence verification. Atomically reserve both attempt and request allowance in Postgres before every dispatch; uncertain dispatches remain spent. Disable automatic SDK/transport retries or reserve every underlying request, including pagination. No dispatch if reservation fails. Monitoring calls and Neon invocations need separate measured budgets; the 200-request count does not cover those services. Exhaustion produces an explicit recovery report, not an infinite loop.
- Four-hour cloud-work window from persisted start time. Proposed scheduler cadence: 15 minutes; metrics are due hourly. Stop starting create/upload operations after minute 30. Start cleanup by hour three, or earlier on failure, leaving one hour for bounded reconciliation and deletion. The metric window ends at cleanup start even if fewer than three observations arrived; missing data is inconclusive. Before enabling mutations, show that measured invocation duration, bounded backoff and trigger delay fit this schedule with margin. No provider delivery deadline is assumed; excessive delay or unresolved calls produce needs-reconciliation at hour four, not success. Do not restart cloud work on late or duplicate triggers.
- Owner-provided eligibility/headroom check at most 24 hours old: account status, home region, aggregate storage, month-to-date requests, applicable transfer allowance, and Neon usage. Reserve at least 10 MiB storage and 200 OCI requests. Estimate Neon consumption from a measured no-cloud-write probe before mutation. Unknown headroom blocks creation, not owned-resource cleanup. The future Functions-only policy below defines a reviewed alternative; the historical one-trial exception remains consumed.
- Compartment metrics provide partial coverage. The dated owner check is not a guarantee against concurrent consumption elsewhere in the account. No provider-enforced spending cap is claimed.

## Revised Functions evidence policy — issue #68, 2026-11-19

Scope: retain Neon Free / Alchemy / OCI initially. The owner accepts unknown
Functions consumption and quota-induced interruption, including loss of hosted
cleanup. This policy is a specification for #69 enforcement and #70 offline owner
recovery qualification. Merging it changes no executable gate, grants no deployment
permission and authorizes no live trial. Until those prerequisites and a separate
owner decision are complete, activation remains no-go.

### Evidence required for a separately authorized future operation

- Record the actual organization/project, branch, billing period, observation time,
  source and reviewer for each evidence item; redact identifiers in published
  reports. Plan status must be verified from an authenticated provider API or dated
  owner Console evidence. Record API-verified and owner-attested status separately.
  No-card status or an empty usage display is not Free-plan verification.
- Require Neon Free and OCI free eligibility/home region, current effective IAM
  review and aggregate allowance evidence. Account/IAM/usage observations must be
  no more than 24 hours old, never future-dated, and remain valid through the
  start-plus-30-minute creation window. Recheck if account activity or plan changes;
  missing, stale, paid, conflicting or unknown required evidence blocks creation.
- Known remaining allowances must cover the operation and its reserves: at least
  10 MiB OCI storage, all 200 Object Storage requests including the protected 40,
  applicable transfer and configured Monitoring limits. Separately qualify Neon
  Postgres storage/compute and aggregate shared network transfer against the full
  preparation, execution and shutdown envelope. Postgres CU-hours cannot stand in
  for Functions capacity-hours; an application invocation budget is not a provider
  usage total. Insufficient or unverified known allowances block creation.
- Review dated official evidence of Neon Free billing behavior for the products
  used. The current basis is $0/month and the provider's no-Free-overage statement,
  not the absence of payment details. If that basis cannot be substantiated or
  changes incompatibly, stop creation and record no-go. No paid upgrade, promotional
  credit dependency or paid add-on may satisfy this policy. No provider hard
  spending cap is claimed; retain `hardSpendingCap=false`.
- Record Functions active/waiting capacity and invocations as provider-reported
  totals with units, period and coverage when available. Otherwise record usage
  and remaining allowance as **unknown**, with the unavailable Console/API surface
  and dated source. Unknown Functions totals alone do not block the future policy.
  Provider-reported exhausted/insufficient Functions allowance does block creation.
  Logs, request ledgers and forward scenarios never populate missing provider totals.
- Retain measured runtime and the separately labeled forward Functions scenario
  for scheduling and risk review. It is not historical headroom or a provider cap.
  No specific Functions quota-exhaustion status code, suspension timing or delivery
  guarantee has been established; accept interruption rather than promise behavior.

### Authorization, cleanup and outcome

A separate explicit owner decision must authorize one new operation and its fixed
four-hour window after readiness review. An owner-prepared durable record must bind
the operation, target, credential identity, policy version and reviewed evidence,
including acceptance of unknown Functions usage and manual-recovery risk. Clients
cannot supply or broaden that authorization. Submission/replay and direct SQL must
enforce the same record. Terminal/expired authorization cannot be renewed or reused;
the #55 singleton and historical ledger must never be reset, deleted or repurposed.

Preserve one bucket/one 1 MiB object, three attempts/action, 160 normal/40 cleanup
Object Storage requests, separate Monitoring/application-invocation budgets and all
ownership/fencing controls. Creation ends at minute 30, cleanup starts by hour three,
and cloud work expires at hour four. Unknown/stale creation evidence must not remove
the owned-cleanup path, but cleanup still requires its own budget, credentials,
ownership and expiry checks. Owner recovery cannot mint requests or extend the
window. After exhaustion/expiry, retain needs-reconciliation and exact leftovers
for separately reviewed owner action, never silently restart the executor.

Before future activation, qualify an independent owner cleanup procedure that can
run without Neon Functions, using retained durable ownership and request evidence.
If Neon SQL is unavailable too, stop safely and report the missing evidence rather
than delete by name. The owner must be available for independent recovery and
administrative shutdown by expiry + 15 minutes; no hosted availability is guaranteed.

Record runtime, lifecycle/checksum, metrics/warning, interruption recovery and
autonomous teardown verdicts separately from Free-allowance evidence. A future
capability may pass only with its own live evidence. Unknown Functions allowance
keeps the overall feasibility verdict **partial**, even if lifecycle succeeds;
missing metrics/recovery evidence also remains partial. Gate failure is no-go for
activation. None of these future results rewrites the November 15 failed lifecycle,
partial/no-go verdict or completed owner closeout.

The dated source assessment and current code/SQL gap are in
[Functions headroom qualification](docs/trial/functions-headroom.md#revised-policy--issue-68-2026-11-19).

## Historical approved one-trial Functions exception (issue #55)

This authorization was consumed by the November 15 attempt and is closed. The
following records its original terms, not instructions to activate another run.

The owner accepted this exception on 2026-11-15: one four-hour OCI trial on the
existing Neon Free project may proceed with unknown remaining Functions allowance.
Require exclusive project use, dated Free-plan/other-service usage and IAM evidence,
explicit acknowledgement of unknown consumption and partial verdict, the separately
labeled 6,000-capacity-second forward scenario, and owner administrative shutdown by
expiry + 15 minutes. Quota exhaustion may prevent hosted cleanup and require manual
owned-resource recovery. All resource, request, ownership and cleanup bounds remain.
A durable owner-prepared singleton binds the authorization to one operation/window;
it remains consumed after failure or success. No invented numeric Functions quota,
paid upgrade, renewed window or automatic reset is allowed. Normal admission remains
fail-closed. This run cannot pass before/after Functions allowance acceptance and
must retain an overall partial verdict independently of lifecycle outcome.

Implementation and precise preparation/shutdown steps are in
[the exception runbook](docs/trial/free-functions-exception.md). The trial owner owns
closure under #14; expiry ends cloud work and the consumed authorization is retained
for audit. No schema installation, deployment or live activation occurs in this PR.

## Acceptance and verification

| Criterion | Required evidence |
|---|---|
| Runtime | Actual Alchemy and OCI SDK load in deployed Neon, with pinned versions and persistent state across fresh invocations. A direct SDK call alone is insufficient. |
| Permissions | Expected lifecycle succeeds; IAM excludes outside-compartment actions and explicitly omitted API permissions. Private creation settings and one-resource limits are application-enforced, not IAM guarantees. Reject invalid configuration and verify actual bucket settings. Missing/invalid manual authentication and forged triggers cause no writes. Runtime DB role has no migration/admin privileges. |
| Preview | Exact private bucket and object proposal; no cloud mutation; unsupported settings and unknown eligibility blocked. |
| Lifecycle | Create through Alchemy, inspect identity, upload/read/checksum 1 MiB; repetition produces no duplicate or overwrite. |
| Usage | Bucket-filtered StoredBytes, ObjectCount and AllRequests with timestamps. Require post-upload data; missing/stale is not zero. Operational request counts are not an exact billing ledger. |
| Warning | Proposed 2 MiB app threshold, warning at greater than or equal to 50 percent. The test object demonstrates warning without nearing the provider allowance. Deduplicate repeated warnings. |
| Recovery | Inject interruption before/after mutations and state writes, including lost success responses; duplicate/overlapping trigger delivery; lease expiry; late create completion during cleanup; durable budget reservation crashes. Converge safely and demonstrate continuation after the initiating client closes. |
| Teardown | Delete only the owned object at its verified revision using conditional deletion, then the empty owned bucket. Stop on unexpected contents, versions, retention or ownership mismatch. Verify absence with authenticated listing; authorization errors are not deletion proof. |
| Outcome | Record before/after free allowances and redacted evidence. Hosted work reaches a durable terminal outcome; account-owner schedule/key cleanup is recorded separately. Missing metrics/recovery evidence means partial, not pass. Report leftovers and manual OCI cleanup if hosting quota prevents execution. |

OCI StoredBytes and ObjectCount are hourly; empty buckets emit no metrics. Allow ingestion delay. Deleting a bucket does not reset accrued usage or justify deleting history.

## Shutdown responsibilities

The hosted executor performs resource teardown and records succeeded, failed or needs-reconciliation. Every subsequent authenticated trigger observes terminal state and performs no OCI work. The persisted start time and deployment expiry must define the same four-hour window before triggers are enabled. A deployment-level expiry check runs before connecting to Postgres after that window, so expired triggers do not keep the database awake; expired invocations can still consume function allowance. Never erase unresolved attempt records at expiry.

The account owner subsequently disables/deletes the Neon trigger, removes deployment secrets and revokes the OCI key. The executor receives no Neon admin key or OCI identity-management permission to perform those administrative actions. Resource lifecycle completion must not depend on owner presence; administrative shutdown is a separate follow-up. In-flight/queued deliveries remain harmless through terminal/expiry checks even after trigger removal. Budget residual no-op invocation consumption until owner cleanup; this trial does not claim automatic schedule removal or zero hosting consumption after expiry. Persistent unattended operation with automatic administrative shutdown remains outside this spike.

## Structure, commands and code style

The repository has an offline Node 24 toolchain; it has no deployed application. `tests/` contains runtime smoke tests, and `docs/` contains setup and audit notes. Future implementation paths are `src/trial/` and `src/providers/oci/`. Exact package pins and working commands are documented in README.md: `pnpm install --frozen-lockfile`, `pnpm run build`, `pnpm run typecheck`, `pnpm run lint`, and `pnpm run test:smoke`. No deployment command exists yet. Document verification command: `git diff --check`.

Use strict TypeScript and explicit Effect dependencies, typed failures and injected credentials. Keep identity data separate from authentication, for example:

```ts
type TrialIdentity = Readonly<{
  operationId: string;
  bucketName: string;
  objectName: string;
}>;
```

Tests should cover validation, ownership, warning boundaries and operation transitions without credentials. Deterministic fake cloud boundaries exercise crash windows and retries. Live tests establish runtime/IAM/metrics behavior; mocks cannot substitute. Do not skip failing acceptance checks, add suppressions to pass them, or invent coverage percentages for this spike.

## Scope boundaries and open decisions

Always keep evidence truthful and operations bounded. Never mutate unrelated resources, silently broaden IAM, adopt colliding names or enable paid plans. Detailed implementation tasks follow specification review. No app, schema or dependency choices beyond this trial are finalized.

Open: actual OCI account/headroom; Neon project and trigger availability; pinned versions; Alchemy execution entry point/state backend; exact scheduler retry/security semantics; final product credential storage.

## Review record

An independent adversarial review found gaps in recovery, authentication, retry bounds, region selection, ownership, metric freshness and headroom. The draft adds explicit requirements for all seven. Their implementation is unproven. The approved Codex CLI read-only review completed on 2026-11-12 using its configured gpt-6-astra model. All eight findings were actionable: distinguish IAM/application enforcement; track unresolved in-flight calls; reserve request budgets atomically; establish ownership markers; use conditional deletion; assign shutdown actors; reserve a cleanup window; require a restricted DB role. This revision addresses those contracts. Owner-only administrative cleanup is an explicit trial limitation. No second CLI pass or live verification has been performed.

## Sources

- [Alchemy providers](https://alchemy.run/infrastructure-as-code/provider/)
- [Custom providers](https://alchemy.run/infrastructure-as-code/custom-provider/)
- [Alchemy state stores](https://alchemy.run/state-store/)
- [Neon Functions](https://neon.com/docs/compute/functions/overview)
- [Neon runtime limits](https://neon.com/docs/compute/functions/reference/runtime-limits)
- [OCI metrics](https://docs.oracle.com/en-us/iaas/Content/Object/Reference/objectstoragemetrics.htm)
- [OCI conditional Object Storage operations](https://docs.oracle.com/en-us/iaas/tools/python/latest/api/object_storage/client/oci.object_storage.ObjectStorageClient.html) (API semantics; verify equivalent fields in the selected TypeScript SDK)
- [Neon trigger management and queued deliveries](https://neon.com/docs/compute/functions/triggers/schedule)
- Account, pricing and IAM sources are linked in the setup guide.
