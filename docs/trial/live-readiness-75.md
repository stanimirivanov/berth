# Read-only live readiness assessment — #75, 2026-11-19

## Decision and issue boundary

**No-go for activation.** Code/offline qualification is complete, but current
aggregate allowance evidence, replacement restricted OCI access, migration 006,
new operation authorization and an owner availability window are prerequisites.
Nothing was provisioned, deployed, installed or enabled by this assessment.

[#75](https://github.com/stanimirivanov/berth/issues/75) owns this completed read-only
assessment. [#76](https://github.com/stanimirivanov/berth/issues/76) is the separate
blocked live-validation task. Closing #75 or merging this report grants no authority
to execute #76. The November 15 lifecycle remains **failed / partial-no-go** and
owner closeout remains complete. Unknown Functions allowance still requires partial
feasibility for any future run, independently of lifecycle success.

## Current authenticated observations

Initial provider reads were collected November 19, approximately **13:15–13:18 UTC /
15:15–15:18 Sofia**, followed by the read-only privilege check and supplemental
compartment-inventory attempt described below.
Private raw responses and CLI errors are retained under
`~/.config/berth-trial/readiness75-01` (owner-only). Published evidence omits private
resource identifiers, credentials, signing headers and provider error bodies.

| Check | Observation | What this establishes |
| --- | --- | --- |
| Neon organization | Authenticated organization GET returns `plan=free` | Current API-verified Free status, not an allowance measurement |
| Project/branch | Saved project and Ohio region match; one branch with no continuation cursor | Existing dedicated target remains available |
| Compute | One idle endpoint, autoscaling 0.25–2 CU; suspend timeout field 0 | Configuration observed; 0 is recorded without treating it as proof that scale-to-zero is disabled |
| Hosting inventories | Zero Functions, empty pagination object; zero triggers | No existing trial hosting/schedule needs removal; not historical zero consumption |
| Restricted SQL | `berth_runtime` login and the existing catalog-only privilege guard pass | No observed owner/admin/table-privilege drift |
| Database allocation | `pg_database_size` = 8,822,784 bytes | Physical database observation, not total provider storage/history or account quota |
| Migration 006 | Both `functions_policy` table and `valid_functions_policy` function absent | Reviewed code is merged but this migration is not installed on Neon; no installation attempted |
| Retained operation | Lifecycle `failed`, feasibility `partial`, Functions allowance `unknown`, hard cap false | Old evidence remains unchanged |
| Old request counters | SQL normal 9, cleanup 16 | Historical owner verification adds two separately reserved reads: original combined cleanup remains **18/40**, not a new budget |
| OCI owner access | Authenticated tenancy, region subscription and namespace reads succeed; namespace matches saved record | Existing owner access works; home region is **eu-frankfurt-1** |
| Old compartment | Owner-authenticated GET returns `DELETED` | Confirms prior dedicated compartment closeout; it cannot be reused |
| Old user's key listing | HTTP 404 `NotAuthorizedOrNotFound` | Consistent with retained user-deletion evidence; not an independent proof of key absence. No revoked trial key was used |

The catalog/operation read ran inside an explicit read-only SQL transaction; the
additional privilege check used a second read-only transaction. No ledger counter,
state, timestamp, authorization, schema, role or grant was changed.

### Usage observations are not remaining allowance

Neon's project GET reports the period **November 12 14:55:47 UTC–December 1
00:00 UTC**, `compute_time_seconds=1929`, `active_time_seconds=7316` and
`data_transfer_bytes=1337940`. Several storage/CPU fields are zero while the live
SQL database has nonzero allocation. Retain these as raw API observations; legacy
field semantics, freshness and coverage do not establish full remaining Postgres,
history or shared all-product transfer allowances. No Functions total is inferred.

Two successful OCI read-only Usage API queries returned:

| Requested interval / granularity | Returned aggregate quantities |
| --- | --- |
| November 1–19 00:00 UTC / daily | Object Storage 0.0085 × 10K Requests; 0.00001267 GB Months; Telemetry 0.07776 Million Datapoints |
| November 19 00:00–13:00 UTC / hourly | Object Storage 0.0006 × 10K Requests; 0.000000033 GB Months; Telemetry 0.00432 Million Datapoints |

Each result is below the 1,000-item limit. The current-day query's returned
intervals start on November 18 and reach only November 19 10:00 UTC. Consequently,
**do not add the two result sets**: windows overlap and reporting is delayed.
GB-months is not current stored bytes; Telemetry datapoints are not Monitoring
request allowance; absence of a transfer line is not zero transfer. These queries
provide consumption evidence, not a complete Free-entitlement/headroom calculation.
No subscription identifier was available in the grouped results for a further
subscription lookup; the tenancy GET does not report current Free Tier plan type.
A bounded active-compartment inventory attempt returned CLI exit 0 with an empty
stdout body; it was not accepted as an empty inventory or retried. No bucket/object
contents were read. Current all-compartment storage remains unqualified.

The initial month-long hourly query returned HTTP 400 with the validation message
that hourly ranges exceed 36 hours. It was not automatically retried. The two
explicitly corrected queries above used separate daily/current-day intervals.
All account commands disabled CLI retries and used bounded timeouts; no pages were
automatically traversed. Six Neon management GETs and nine OCI account requests
were attempted, plus two SQL sessions. Local CLI help checks made no account calls.
These administrative reads can accrue usage/wake compute; they are outside the
old finalized operation and are not inserted retroactively into its ledger.

## Public policy evidence rechecked November 19

- [Neon plans](https://neon.com/docs/introduction/plans#usage-metrics) omits Functions
  totals from its Console usage summary. [Consumption metrics](https://neon.com/docs/guides/consumption-metrics)
  restricts the Functions-capable v2 endpoints to paid plans. No repeated Free 403
  request or paid upgrade was attempted.
- [Monitoring dashboard](https://neon.com/docs/introduction/monitoring-page)
  documents a Functions tab for logs. It is not a complete billing-period allowance
  meter; no deployment was created to populate it.
- [Official Free-plan FAQ](https://github.com/neondatabase/website/blob/main/content/faqs/free-plan-limits-and-quotas.md)
  states no Free overage billing. This remains the dated billing basis in the
  reviewed policy; exact monthly Functions exhaustion behavior remains unverified.
- These public documents cannot establish this tenancy's account type or current
  remaining quotas. Preserve `hardSpendingCap=false` and unknown Functions totals.

## Prerequisite matrix and order

| Prerequisite | Status / next action |
| --- | --- |
| Merged policy, enforcement, offline owner recovery | Complete through #68–#70; retained 158-test crash/security qualification is separate from this assessment |
| Fresh Neon Free status | Verified now; refresh near an approved operation so evidence covers creation cutoff |
| Current OCI account type | Pending owner Console observation below; home region already verified |
| Known aggregate allowances | Pending complete, dated observations and reviewed envelope; query totals above are insufficient |
| Replacement compartment/identity/policy/key | Absent by design after closeout; separate explicit provisioning authorization required, then review all effective grants and group memberships |
| Migration 006 | Not installed; separately authorize one owner-only application after checking predecessors and preserving all old evidence |
| New operation/window/authorization | Not prepared; choose only after readiness review and a separate explicit owner decision |
| Owner recovery and shutdown availability | Procedure qualified offline; actual owner time/window and private usable inputs still need confirmation |
| Release checks and bundle binding | Canonical assessment checks below; freeze the actual future deployment commit/bundle and require current admission/full recovery gates before activation |

Do not collect repeated expiring attestations while provisioning remains
unauthorized. Resolve policy/account questions first; schedule approved preparation,
then refresh account/IAM/usage evidence within 24 hours and valid through start +
30 minutes. No existing operation, timestamp, consumed exception or revoked key
may be reset, extended or reused.

## Exact owner observations still needed

### OCI account type

1. Open the OCI Console in **Germany Central (Frankfurt)** using the owner account.
2. Open the navigation menu → **Billing & Cost Management** → under **Billing**,
   **Upgrade and Manage Payment**.
3. Read **Subscription Information → Plan Type** and any promotion/trial-expiry
   message. Do not click Upgrade, change payment details or submit anything.
4. Provide only the exact Plan Type text, any expiry text, and observation time with
   timezone. Omit account name, email, address and payment details.

Oracle documents these screen names in
[Managing Account Upgrades and Payment Method](https://docs.oracle.com/en-us/iaas/Content/Billing/Tasks/changingpaymentmethod.htm).
If the screen is unavailable, report its exact title/error; do not infer account type
from an expired promotion, zero charges or successful API access.

### Neon known usage (refresh near any future approved window)

1. Open the Neon Console and select the same organization/project used for Berth.
2. On **Organization → Projects**, record the account summary's **Compute, Storage,
   History and Network transfer**, including units and period.
3. Open **berth-trial → Overview → Usage** and record those four project values and
   the displayed **Since** date. Report unavailable/stale fields as such, not zero.
4. Provide the observation time/timezone and whether other projects/workloads have
   consumed these shared allowances. Free status is already API-verified; there is
   no need to resend an unavailable Functions counter or inspect card details.

These navigation paths and potential metric delay are documented in
[Monitor billing and usage](https://neon.com/docs/introduction/monitor-usage).
The reviewer must reconcile observation periods, storage/history coverage and the
full preparation/execution/shutdown envelope before asserting remaining headroom.

### OCI activity scope and engineering-owned allowance qualification

Provide whether any people, workloads or services outside the recorded Berth work
used OCI Object Storage, outbound transfer or Monitoring since **November 19
10:00 UTC / 12:00 Sofia**, the latest returned usage boundary. “Unknown” is valid;
do not infer no activity from a missing line. Mention any other active regions or
compartments without sharing their private identifiers.

Do not repeat the same Cost Analysis export merely to reproduce the API's delayed
or missing rows. The agent/reviewer still owns reconciling supported usage coverage,
current applicable Free entitlements, the reporting tail and bounded current storage
inventory. Remaining capacity must cover at least 10 MiB storage, 200 Object Storage
requests and the reviewed transfer/Monitoring envelope. This assessment has not
established those aggregate remaining figures. If they cannot be established,
unknown required OCI/Postgres/shared-transfer allowance remains a creation blocker
under SPEC.md; no Console-only workaround or paid telemetry option is assumed.

## Proposed bounded run — #76, still blocked

Use one private bucket and one 1 MiB object, 160 normal / **40 exclusively cleanup**
Object Storage requests, Monitoring limit 20 and 64 application units including
**12 protected cleanup units**, with at most three attempts/action. End creation at
minute 30, begin cleanup by hour three and expire cloud work at hour four; owner
administrative shutdown is due fifteen minutes later. A controlled missed delivery
is conditional on verified upload and adequate time/capacity before hour two.
Missing metrics stay inconclusive and never delay teardown. Owner fallback does
not pass autonomous hosted teardown. Capabilities and this operation's outcome
must be recorded separately from historical failure and unknown Functions allowance.

## Repository verification

`pnpm check` passed the included fast checks, 168 application tests, 30 harness
tests, runtime bundle build, secret scan and unchanged native high-severity audit
gate. Seven moderate and one low advisories remain visible. `git diff --check`
passed. No behavior changed, so no new behavioral tests or repeat database crash
run were required; #70's complete recovery evidence is retained and labeled as prior
qualification, not a fresh live result. This PR changes only this report and the
ordered issue index. Raw account evidence remains private, outside Git.
