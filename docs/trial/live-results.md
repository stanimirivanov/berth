# Hosted OCI trial — issue #14

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
