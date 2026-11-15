# Hosted OCI trial — issue #14

**Latest result (2026-11-15): partial / no-go.** The approved one-use live attempt
created a bucket, failed before upload, and required bounded owner cleanup.
The bucket, function and trigger are gone; the trial key is revoked. See the
[final acceptance ledger](#final-acceptance-ledger-and-decision). Earlier blocked
preflight entries below are retained as dated history.

## Initial status on 2026-11-14

**Blocked before activation; no live feasibility pass.** The implementation
prerequisites (#43, #46 and #47) are merged. Fresh owner eligibility, aggregate
allowance headroom and effective-IAM evidence have not yet been supplied for this
run. Do not replace these inputs with the old synthetic proof or delayed API
counters. No operation has been prepared, no migration installed, and no function,
trigger, bucket or object created during this preflight.

The continuation branch is `feature/issue-14`, based on `31673ad` (merged PR #49).
The [activation runbook](hosted-admission.md) remains the execution procedure.
The [feasibility decision](feasibility-decision.md) distinguishes the earlier
synthetic proof from the pending real lifecycle.

## Timestamped preflight evidence

| UTC / check | Observed result | Limit of evidence |
| --- | --- | --- |
| 2026-11-14 17:57:23.904 / OCI doctor | Passed in one attempt, three dispatched requests; HTTP 200; clock skew -1 second | Read-only GetNamespace, ListBuckets and Monitoring query; no effective-IAM audit |
| Same check / dedicated compartment | Authenticated namespace and empty-compartment verification passed | Current preflight inventory, not post-teardown absence evidence |
| Same check / Monitoring | `inconclusive-no-metrics` | Empty target has no post-upload samples; missing data is not zero usage |
| 2026-11-14 17:57:59.181 / Neon management | Three GET requests; project in `aws-us-east-2`; zero functions and zero triggers | Does not establish current Free status or available Functions allowance |
| Same check / project counters | `cpu_used_sec=0`, `data_transfer_bytes=599833`, `data_storage_bytes_hour=0` | Delayed project counters; neither remaining allowance nor zero billed consumption |
| Same check / restricted SQL login | Existing `verifyPrivileges` passed in a read-only transaction | No owner role, broad role flags/membership, CREATE/TEMP or unexpected protected table grants; deployed credential injection remains untested |
| Same check / trial schema inventory | None of `berth_state`, `berth_ledger`, `berth_executor`, `berth_usage` present | Fresh owner installation is still required before preparing an operation |

The live bundle built with pinned Node 24.22.3 / pnpm 12.16.1 is 374,691 bytes,
SHA-256 `732225ecf3c5bdc556f09bd4dd839f9af30634ca3ce1061297f95f38e0d86b06`.
This identifies the local ZIP only; no matching hosted deployment exists yet.
Alchemy is pinned to 2.0.0-beta.86, Effect to 4.1.4 and OCI SDK to 2.146.0.

The three OCI diagnostic requests and three Neon management reads happened before
any operation ledger existed. Keep them in account-wide usage evidence; do not
claim they were charged to a nonexistent trial ledger or reset accrued usage.
Private credentials and raw provider bodies remain outside the repository.

## Inputs required before creation

The follow-up below resolves Neon plan status, region, IAM and current storage
inventory. Its remaining owner steps supersede requests to repeat those checks.

Record the observation time and source for each item. Both allowance and IAM
attestations must remain fresh through the prepared start plus 30 minutes.

- OCI account type (`always-free` or `free-trial` under the current contract),
  home region, and aggregate remaining Standard storage, monthly Object Storage
  requests and applicable outbound transfer. Required reservation: at least
  10 MiB storage, 200 Object Storage requests and 1 MiB transfer.
- Remaining Monitoring allowance covering the chosen separate Monitoring budget.
- Current Neon Free status, remaining Functions invocations and compute allowance,
  plus Postgres/storage/transfer headroom for the complete window and administrative
  shutdown. The minimum live invocation budget is 40; use 64 only with headroom.
- A measured no-cloud-write runtime basis for the whole-window compute estimate.
  Handler durations from the old synthetic proof exclude platform overhead and
  cannot alone establish billed compute consumption.
- Owner review of every effective grant and group membership for the dedicated OCI
  identity. Successful read authentication does not establish restricted mutation
  permissions. Preserve the scoped policy; do not broaden it to pass the trial.

Do not put credentials, signing keys, connection URLs or API tokens in this report.
Owner attestations belong in the private preparation inputs described in the
runbook; publish only their redacted status, time, scope and allowance figures.

## Acceptance ledger

| SPEC.md row | Live status / remaining evidence |
| --- | --- |
| Runtime | Pending deployed Alchemy + OCI execution, deployment/build identity and persistent state across fresh invocations |
| Permissions | Local restricted SQL login passed; pending effective IAM review, deployed DB restrictions, private bucket settings and authenticated edge checks |
| Preview | Pending exact signed proposal and metered credential checks; no live preview submitted |
| Lifecycle | Pending Alchemy creation, identity inspection, 1 MiB upload/read/checksum and duplicate safety |
| Usage | Pending fresh bucket-filtered StoredBytes, ObjectCount and AllRequests with post-upload timestamps |
| Warning | Pending persisted, deduplicated warning at >=50 percent of the 2 MiB application threshold |
| Recovery | Pending one controlled missed scheduled delivery and resumed hosted continuation with no initiating client; local fault matrix is separate evidence |
| Teardown | Pending conditional owned deletion, valid authenticated identity plus absence listing, and zero unresolved attempts |
| Outcome | Pending before/after allowances, durable terminal result, 160/40 Object Storage split, separate Monitoring/Neon counters, four-hour bounds and administrative shutdown |

No trial resources were created by these checks, so there is no new live operation
to tear down. Existing dedicated IAM/bootstrap credentials remain owner-managed;
their continued presence is not a lifecycle acceptance result.

## Local verification

`pnpm run check` passed, including the fast gates, 144 application tests, 24 harness
tests, runtime-probe bundle, secret scanning and dependency advisory gate.
`pnpm run build:live-executor` passed separately. Existing advisories remain seven
moderate and one low, with no high/critical findings. These checks do not satisfy
live acceptance rows. This change records observations only; no behavior changed,
so the TDD skill's documentation-only exception applies.

## Resume and verdict rule

After the owner supplies the missing evidence, recheck time-sensitive readiness,
install the fresh schemas, and follow the runbook for exactly one prepared window.
Retain this preflight record and append the actual operation's timestamped evidence.
Do not extend the four-hour window, increase budgets, change to paid plans or create
a second operation to conceal an uncertain outcome.

Until then the decision is **no-go for activation, feasibility unproven**, rather
than a finding that Neon or Alchemy cannot work. Missing metrics, recovery proof,
headroom or authenticated teardown after activation must remain partial/blocked.
Issue #14 stays open until its live evidence and final verdict have been reviewed.


## CLI/API follow-up — 2026-11-14, completed 18:06 UTC

The owner authorized read-only use of the existing administrator and management
credentials. OCI CLI 3.96.2 used explicit configuration, no automatic retries,
bounded pages and timeouts. Neon checks used the documented REST API with the
existing key; credentials and raw replies remain private. No cloud mutations.

| Check | Evidence |
| --- | --- |
| Neon plan | Organization API returned `plan=free` |
| OCI home/subscribed regions | Frankfurt (`eu-frankfurt-1`), sole subscribed region |
| OCI compartment scope | One active child compartment, the trial; direct child of tenancy root |
| OCI effective resource policies | Root has restricted three-statement trial policy plus Administrators policy; trial compartment has no policies; no pagination token on inventories |
| Trial identity | ACTIVE; IAM and Identity Domains each return only `berth-trial-executor` membership; API keys enabled, other exposed credential capabilities disabled |
| Storage inventory | Trial empty; root has one existing Standard bucket, versioning disabled, approximately one object / 46,377 bytes; unrelated bucket untouched |
| OCI subscription | ACTIVE record, payment model `FREE_TRIAL`, promotional end 2026-09-02; insufficient to distinguish current post-promotion Free Tier status without Console confirmation |
| OCI billing usage | Nov 1 inclusive to Nov 14 00:00 UTC exclusive: 46 Object Storage requests; 56,160 Monitoring retrieval datapoints; storage 0.000000301704 GB-month; no transfer SKU returned |
| Neon consumption API | Correctly parameterized request returned 403: endpoint included with Launch plans and above; no upgrade attempted |

Storage GB-month is not current bytes. Monitoring datapoints are not request counts.
Missing transfer rows do not prove zero transfer. Today's activity and reporting
lag are not included in the midnight usage snapshot. The existing storage inventory
strongly supports storage headroom but cannot establish monthly requests/transfer.
The first OCI usage call was rejected for daily timestamp precision, then corrected
to midnight; the first Neon consumption call lacked the required metrics parameter,
then a corrected read established the Free-plan restriction. Neither failed read
was treated as successful evidence or automatically retried.

### Remaining owner steps

1. **OCI account status:** Navigation menu → **Billing & Cost Management** →
   under **Billing**, **Upgrade and Manage Payment**. Read **Subscription
   Information → Plan Type**. Do not select upgrade or change payment details.
   Return the exact Plan Type and any free-trial expiry/credit status text. This
   resolves the expired promotional date in the API record.
2. **OCI usage gap:** Navigation menu → **Billing & Cost Management** →
   **Cost Analysis**. Set the date range to the current month through today,
   tenancy-wide (no compartment filter). Select usage rather than cost where
   available, and inspect Object Storage request and outbound-transfer SKU rows,
   preserving units and the latest available timestamp. Return these rows or
   `not displayed`. Zero cost and absent rows must not be converted to zero usage.
   Also state whether any workloads other than Berth have used Object Storage,
   outbound transfer or Monitoring since Nov 14 00:00 UTC; if so, describe their
   scale. The CLI already checked storage inventory, region and IAM.
3. **Neon usage:** Open Console, select the project's organization from the
   top-right profile menu, then **Projects** → the trial project → **Overview**.
   In **Usage**, copy Compute, Storage, History and Network transfer values,
   units, period and any displayed limits. Plan status is already API-verified.
   At organization level, **Billing** shows the current billing period and plan
   summary; record any Functions invocation/active/waiting compute usage displayed.
   If those fields are absent, report `Functions usage not displayed`; do not use
   Postgres CU-hours as Functions capacity-hours. The published Console summary
   does not guarantee these Functions metrics are exposed on Free.
4. State whether this Neon project has had any Functions activity besides the
   recorded Berth trials. If Functions counters are unavailable, a conservative
   reconstruction from private deployment/trigger journals is an investigation,
   not verified billing evidence. The measured runtime basis remains our task;
   the owner is not asked to invent a compute estimate or attest unknown usage.

Return only statuses and numeric usage, with observation time/timezone. No account
IDs, emails, API keys, OCIDs or connection strings are needed. Unknown figures
remain blockers under the current admission contract; a missing provider meter
may require a bounded follow-up rather than a paid upgrade or assumed zero usage.

Sources checked 2026-11-14:
- [OCI account status navigation](https://docs.oracle.com/en-us/iaas/Content/Billing/Tasks/changingpaymentmethod.htm)
- [OCI Cost Analysis](https://docs.oracle.com/en-us/iaas/Content/Billing/Concepts/costanalysisoverview.htm)
- [Neon Console usage locations](https://neon.com/docs/introduction/monitor-usage)
- [Neon consumption API plan availability](https://neon.com/docs/guides/consumption-metrics)


### Historical usage reconstruction check — 2026-11-14

Read the existing private probe, Cloudflare-state, checkpoint and executor journals
without replaying requests or reading their credentials into the report. These
artifacts cannot establish aggregate Functions allowance headroom:

- The runtime-probe journal records 23 client invocation entries; the Cloudflare
  state trial records 12 invocation intents; checkpoint and executor journals
  record five and nine manual invocations respectively. These are client records,
  not total provider invocation counts; scheduled deliveries and rejected requests
  are not exhaustively represented.
- The executor's first saved log export explicitly has `is_truncated=true` and a
  continuation cursor. Its later export contains 22 records and is not truncated,
  but that does not establish coverage of the missing earlier interval. Log rows
  are not necessarily one-per-invocation or billed capacity measurements.
- Saved checkpoint, executor and Cloudflare-state Neon teardown reports each record
  zero functions and zero triggers. This supports their shutdown evidence, not a
  claim that their accrued usage vanished.
- No connected OCI/Neon Console tab was available for direct UI verification.

Do not populate `neonInvocations`, `neonComputeSeconds` or
`measuredComputeSeconds` by treating these partial counts as complete or handler
latency as billed capacity. No reliable remaining allowance or measured
whole-window compute basis was recovered. The owner Console observations requested
above remain necessary; if Functions metering is unavailable there too, record that
explicitly and resolve the evidence gap before activation. No deployment, schema
installation, schedule or OCI mutation was performed during this investigation.


## Owner Console evidence and CI triage — 2026-11-14

The owner supplied the following Console observations. Exact observation time and
whether there was non-Berth activity are still requested; do not stamp them with
an invented `checkedAt` time for admission.

| Item | Owner-reported value |
| --- | --- |
| OCI account | Free Tier account; resolves the ambiguous expired promotional record as an owner attestation |
| Neon billing | Free Plan, $0/month |
| Project | Ohio; one production branch; default compute 0.25–2 CU; Postgres 18; six-hour history retention |
| Usage period | Since November 12, 2026 |
| Postgres compute | 0.33 CU-hours used; displayed plan allowance 100 compute hours |
| Postgres storage | 32.1 MB used; displayed allowance 1 GB |
| History | 118.7 kB |
| Network transfer | 600 kB |
| Neon Object Storage | 0 kB; separate from this trial's OCI object storage |
| Functions usage | Not displayed in Console |

Do not ask the owner to find a Functions counter again: both the API restriction
and its absence from the Console are now evidenced. Postgres usage is not Functions
usage. Remaining activation gaps are a dated aggregate OCI allowance attestation
covering recent activity, and a defensible Functions headroom/whole-window compute
basis. A statement about other project activity may help scope a reconstruction,
but it does not make incomplete invocation logs into exact billing measurements.
No runtime guard was relaxed and no live operation was started.

### Reported recovery cancellation

The supplied 13m43s recovery excerpt matches PR #50 run
[43626270858](https://github.com/stanimirivanov/berth/actions/runs/43626270858).
GitHub's check annotation explicitly says the job exceeded its **15m0s maximum**.
Recovery started at 18:24:19 and was canceled at 18:38:02 UTC. The preceding run
[43624785292](https://github.com/stanimirivanov/berth/actions/runs/43624785292)
passed the full workflow in 10m33s with unchanged test code. This establishes the
observed cancellation cause, not the cause of runtime variation or a new teardown
correctness failure. Later crossed-out test names alone cannot establish separate
assertion failures; the canceled run remains incomplete.

The bounded CI follow-up is [#51](https://github.com/stanimirivanov/berth/issues/51):
measure and isolate/partition recovery work while proving complete crash coverage,
preserving time limits, assertions and real process/SQL boundaries. Do not raise
budgets or mark this checkpoint green based on partial progress. No CI change is
included in this live-evidence PR.


## Owner scope confirmed; remaining engineering gates — 2026-11-14

The owner confirms Neon has only been used for our Berth trials and no other
applications, scripts or people are using OCI. The Console figures were read just
before their message, in Sofia local time (UTC+02:00 on this date). Exact minutes
were not supplied; retain that precision rather than invent an epoch timestamp.
No further owner Console search is requested. Recheck freshness at actual activation.

The remaining issue is a Functions evidence contract, not missing owner cooperation:

- The measured no-cloud-write probe recorded 2,252 ms client elapsed and 1,547 ms
  handler time. It demonstrates runtime execution; it excludes a complete billing
  breakdown and does not measure the later real OCI workload.
- A planning allowance of 64 calls × 60 seconds is 3,840 capacity-seconds, or
  **1.0667 capacity-hours**. Charging all of that to active compute is 10.67 percent
  of the published 10 active capacity-hour allowance. This is a forward estimate,
  not remaining allowance, measured OCI duration or a cap on provider invocations.
- The 64-unit application counter excludes some rejected/load-failed/expired calls.
  Historical logs do not establish a complete total. Owner-exclusive use narrows
  activity scope, but does not eliminate platform retries or turn logs into billing.
- Neon documents one runtime hour as one capacity-hour at fixed function size.
  Its default 100 concurrent invocation limit is explicitly not a hard ceiling;
  multiplying deployment lifetime by that value would not prove an upper bound.

[Issue #52](https://github.com/stanimirivanov/berth/issues/52) now owns qualification
of a defensible Free-tier evidence/estimate method. Any necessary headroom-contract
change must receive explicit review in that dedicated change before activation;
no unsupported values were written into `neonInvocations`, `neonComputeSeconds`
or `measuredComputeSeconds`. This follows the quality contract and SPEC.md's
unknown-headroom gate, not a newly imposed requirement for an exact billing ledger.

**Current verdict: live trial blocked before activation, Neon/Alchemy live OCI
feasibility not yet established.** Remaining engineering prerequisites are #51
(reliable complete recovery CI) and #52 (Functions headroom evidence). The earlier
owner-information requests are resolved to the precision stated above. No cloud
resources, schemas or schedules were created by this follow-up.

Sources rechecked:
- [Functions capacity units and allowances](https://neon.com/docs/introduction/plans#functions)
- [Runtime concurrency limitations](https://neon.com/docs/compute/functions/reference/runtime-limits#concurrency)
- [Retry behavior](https://neon.com/docs/compute/functions/triggers/overview#delivery-and-retries)

## Approved one-trial exception — 2026-11-15

The owner explicitly authorized activation after PR #56 merged. This supersedes
previous activation blockers without turning missing Functions billing evidence
into headroom. The immutable exception is consumed once; overall feasibility must
remain **partial**, even if resource lifecycle cleanup succeeds. No paid upgrade,
new operation, expanded allowance or reset of the exception is permitted.

### Preparation and build

- Branch `feature/issue-14`, merged prerequisites at `d0faacf`; merged trial source
  commit `7c940b1`. Node 24.22.3, pnpm 12.16.1, Alchemy 2.0.0-beta.86,
  Effect 4.1.4, OCI SDK 2.146.0 and Neon CLI 9.4.0.
- Full local `pnpm check` passed: 156 application tests, 28 harness tests, bundle,
  secret and advisory gates. Existing seven moderate / one low advisories remain;
  no high/critical findings. Recovery coverage and its sharded CI gates are unchanged.
- Live ZIP: 375,420 bytes, SHA-256
  `145b3ea81137a77422bac8e9630b14c26c933b95cf396779b55441c2f74fb39a`.
- Fresh OCI doctor at 13:10:43 UTC passed one attempt / three requests, zero clock
  skew, empty dedicated compartment and inconclusive metrics. Fresh administrator
  reads reconfirmed the sole Frankfurt region, the trial user's sole restricted
  group, its three scoped policy statements and no compartment policies. The
  unrelated root bucket (approximately one object / 46,377 bytes) is untouched.
- Neon API at 13:12:30 UTC returned Free, Ohio, one branch / one endpoint, zero
  functions / triggers and no pre-existing trial schemas. Restricted SQL checks
  passed before and after installing migrations 001–005. Database size before
  installation: 8,052,736 bytes; this is not the billing storage meter.
- Owner Free Tier / exclusive-use observations remain the previously supplied
  evidence. Their conservative freshness lower bound is November 14 17:57:23 UTC,
  not a newly invented Console reading. It covers creation cutoff on November 15
  at 14:05 UTC. IAM was independently rechecked during this preparation.
- Owner preparation committed at 13:20:56 UTC. Exactly one operation is bound to
  **13:35–17:35 UTC** (15:35–19:35 Sofia), shutdown due **17:50 UTC**. The stored
  report immediately returned `feasibility.verdict=partial` and Functions allowance
  `unknown`. The slot remains consumed even if deployment or execution fails.
- Limits are unchanged: Object Storage **160 normal + 40 cleanup**, Monitoring
  **20**, Neon application units **64**, including **12 protected cleanup units**.
  The 6,000-capacity-second forward scenario is an assumption, not remaining
  allowance or a provider spending cap.
- Deployment 1 completed at 13:24:43 UTC with Node 24. Both database URLs use the
  restricted role; injected privileged defaults are overridden. No Neon API key or
  owner SQL credential is deployed. The fixed 15-minute trigger was created
  disabled and inspected before activation.

### Aggregate evidence limitations

OCI billing usage through November 15 00:00 UTC (exclusive) reports 54 Object
Storage requests and 60,480 Monitoring retrieval datapoints. Storage is expressed
as GB-month, not current bytes. The transfer SKU has an inconsistent provider unit
(`GB Months`); it is retained privately without converting it into an invented
remaining transfer allowance. Current-day activity and reporting lag are excluded.
Fresh storage inventory, the owner-confirmed exclusive workload scope and recorded
small Berth activity support the reserved trial headroom; they are not a hard cap.

This preparation made four Object Storage diagnostic reads and one Monitoring
query before the operation ledger existed, plus bounded IAM/billing/Neon management
reads. These remain separate aggregate usage; they are not retroactively booked
into the ledger. The 40-request cleanup reserve is not borrowed for preparation.
Neon's delayed project counters and the owner's previously recorded Postgres
usage are distinct from the unavailable Functions meter. Functions allowance stays
unknown throughout this exception.

### Activation — 13:35 UTC

- Missing bearer on `/evidence`: HTTP 401 (580 ms). Manual `/scheduled` without
  gateway attestation: HTTP 401 (160 ms). Neither starts provider work.
- `/preview`: HTTP 200 (1,820 ms), exact private Standard bucket / disabled
  versioning and one create-only 1 MiB object, fixed digest and budgets. Returned
  signed qualification: partial, unknown Functions allowance, no hard spending cap.
- `/submit`: HTTP 202 (909 ms), same operation/window and partial qualification.
  Trigger enabled for the first scheduled delivery at 13:45 UTC. The initiating
  client process exited after submission and enablement. This establishes client
  independence for subsequent deliveries, not physical disconnection of the owner's
  computer; separate read-only observation/admin processes remain available.
- SQL snapshot after that exit: phase `bucket`, active, two normal requests for
  admission checks, two Neon units, zero Monitoring / cleanup usage, zero hosted
  deliveries. All 40 cleanup requests and 12 protected Neon units remain reserved.

### Hosted failure and bounded owner recovery

At 13:45:01 UTC the scheduled function acquired durable execution state after the
initiating client had exited. Alchemy created the owned bucket at 13:45:02 UTC and
persisted its provider identity, revision and marker. The second deterministic
subdelivery selected the object phase, but stopped during bucket list/get before
persisting an upload intent or issuing PUT. At 13:46 UTC the database reported
`phase=cleanup`, `outcome=needs-reconciliation`, `reason=unresolved-provider-call`.
All nine normal request reservations were settled; two logical attempts remained
open. No 1 MiB object was uploaded and no checksum receipt exists.

The failure is an OCI read-contract mismatch, tracked in
[#57](https://github.com/stanimirivanov/berth/issues/57). `bucketClient.get` does not
request `fields: ["autoTiering"]`; OCI's pinned SDK documents this as an opt-in
GetBucket field. Validation nevertheless requires the returned value to be
`Disabled`. Create returned the setting, while the subsequent unqualified read
could not satisfy that validation. The SDK contract and live corrective reads
support this diagnosis; the hosted stored reason itself is generic and does not
identify the individual failed guard.

The schedule was disabled before its next delivery to avoid repeating the same
failure. No deployment was changed and no second trial was prepared. The owner
recovery client used the existing compiled executor, restricted DB/OCI credentials,
existing operation and cleanup phase, with only its SDK GetBucket calls adding the
explicit `autoTiering` field. This was **local manual recovery**, not a successful
hosted continuation or the planned interruption experiment. Existing ownership,
configuration, revision, empty-inventory, reservation and no-retry guards remained
in force; no omitted setting was treated as safe.

Three corrective reads returned `autoTiering=Disabled`, private access, Standard
storage, disabled versioning and matching body/header ETags. The executor verified
empty object/version/upload inventories, used Alchemy's destroy path and deleted
the bucket conditionally at 13:50:23–13:50:25 UTC. The 13:50:32 SQL report retained
`trial.outcome=failed` and `feasibility.verdict=partial`, with zero unresolved
requests and zero open attempts. Each logical action used ordinal 1; no retries
or new upload/create attempts were introduced. `object_removed=true` means the
empty inventories were verified, not that an uploaded object was successfully
round-tripped.

### Final accounting and shutdown

| Scope | Final evidence |
| --- | --- |
| Normal Object Storage ledger | 9 / 160 requests; includes two admission checks and one bucket creation |
| Cleanup Object Storage ledger | 16 / 40 requests; includes conditional bucket deletion and absence listing |
| Independent owner absence checks | Two additional cleanup reads reserved in the private owner journal before dispatch, after SQL terminal status; combined cleanup use **18 / 40**, 22 unused |
| Preparation Object Storage reads | Four before the operation; total documented Object Storage requests for this resumption **31** (4 + 9 + 16 + 2) |
| Monitoring | Operation 0 / 20; one separate preparation query; no post-upload samples |
| Neon application accounting | 5 / 64 units: two HTTP admissions, two hosted subdeliveries, one local recovery execution; these are not provider-billed invocation counts |
| Invocation/attempt records | Three execution request reservations plus two HTTP receipts; all 28 ledger reservations settled; all five logical attempts closed |
| Resource footprint | One bucket created/deleted, zero object uploads; unrelated root bucket untouched |
| Protected cleanup | Only one execution unit was needed for local cleanup; neither the 40-request nor 12-unit protected allowance was expanded |
| Function / trigger shutdown | Both deleted, inventories verified empty at **13:51:12 UTC**, well before the 17:50 shutdown deadline |
| Authenticated final absence | At **13:51:48 UTC**, the restricted key authenticated GetNamespace and a complete empty dedicated-compartment listing; errors were not interpreted as absence |
| Credential revocation | Dedicated trial API key deleted at **13:52:29 UTC**; subsequent administrator key inventory contains zero keys for the trial user; administrator key untouched |
| Durable evidence | SQL operation, consumed exception, usage history and private recovery journal retained; no counter/slot reset |

The two owner post-terminal reads are **not** silently inserted into SQL's finalized
16-request cleanup counter. Their separate reservations and results are retained
in the owner journal and included in the same 40-request overall cleanup ceiling.
No further provider request was used to test the revoked key. Old local bootstrap
configuration now references a revoked key and must not be treated as reusable.
Dedicated IAM/compartment remnants and private-file retention remain owner closeout
items under #15; no unrelated account resource was removed.

Neon's post-shutdown API snapshot at 13:52:55 UTC was unchanged from preflight:
`compute_time_seconds=1344`, `cpu_used_sec=0`, `data_transfer_bytes=616670`,
`synthetic_storage_size=0`. The unchanged delayed counters do **not** mean this run
was free of consumption. OCI's latest available complete daily billing window
still predates this attempt; no contemporaneous billed after-value is claimed.
The application/request journals establish bounded activity, not billed cost or
remaining Functions allowance. Functions allowance remains unknown.

### Final acceptance ledger and decision

| Acceptance row | Verdict and actual evidence |
| --- | --- |
| Runtime | Partial: hosted Node 24 / Alchemy created a real OCI bucket after the initiating client exited; durable state was recovered by a separate local process |
| Permissions | Restricted SQL and IAM checks passed; unauthenticated controls rejected; private bucket settings verified during owned recovery |
| Preview | Passed exact signed proposal, credential checks and durable 202 admission, with explicit partial/no-hard-cap qualification |
| Lifecycle | Failed before object upload/read/checksum; bucket creation alone does not satisfy the full journey |
| Usage / warning | Inconclusive: no uploaded object, no fresh metrics and no persisted warning; absent data is not zero usage |
| Controlled interruption | Not performed: the upload/observe prerequisite failed; schedule disablement for recovery is not counted as that proof |
| Teardown | Owner recovery and authenticated absence passed within reserve; **hosted autonomous teardown is unproven** |
| Outcome / allowance | Durable failed lifecycle, mandatory partial feasibility, early verified hosted shutdown, revoked trial key; provider billing deltas and Functions allowance remain unknown |

**Partial verdict; no-go for rollout or another live attempt.** The experiment
found a concrete provider integration defect and safely removed its resource with
manual assistance. Fix #57 with failing-first SDK contract tests, preserving all
recovery coverage and fail-closed validation. Complete/review #15 owner closeout.
The one-use exception is consumed: merging a fix does not authorize another trial,
reset the slot, replenish counters, or prove the remaining live acceptance rows.
PR #50 remains draft for review of this partial evidence; #14 is not presented as
a successful feasibility pass.

### Evidence hygiene and final local checks

A single bounded Neon log query covering 13:24–13:53 UTC returned 22 records, with
no truncation or next page. A private comparison found no deployed secret, database
password/URL, owner connection URL or Neon API key values in those records. This
checks that returned window only, not all possible platform logs. Raw responses,
credentials and resource identifiers remain outside Git. The worktree/index/history
secret scan and `git diff --check` passed. No production behavior or recovery tests
were changed in this evidence PR; the earlier full canonical check applies to the
exact deployed source, with commit-time fast gates checking the final documents.
