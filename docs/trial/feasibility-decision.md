# Hosted Neon / Alchemy checkpoint — issue #6

## Decision

The narrow adapter is suitable for continuing the synthetic hosted trial. This is
not approval to mutate OCI yet: live OCI conditional behavior, current aggregate
headroom and the operation-attempt journal remain gates for the provider/lifecycle
issues. No paid service, broad runtime credential or general workflow engine is
introduced. The two-step checkpoint is a disposable qualification fixture.

## What is deployed

- `checkpoint-index.ts`: Node 24 composition, both restricted database URLs,
  certificate validation, per-invocation DB client and credential checks.
- `checkpoint-handler.ts`: two fixed POST routes. `/evidence` requires the private
  bearer token and never mutates; `/scheduled` requires Neon's edge attestation
  and a consistent bounded envelope. Never expose this handler behind another edge.
- `checkpoint-run.ts`: one acquired generation per execution; two fixed steps.
  First creates synthetic state. A later occurrence loads it, updates the marker
  and destroys it through real Alchemy. Every operation uses `fenced-state.ts`.
- `sql/checkpoint.sql`: two owner-held durable intent/completion receipts. Runtime
  can call guarded functions, not write tables or install schema. A pending receipt
  blocks further mutations for inspection. It is not a generic recovery engine.
- Completed duplicate deliveries are no-ops; terminal deliveries perform no state
  mutations. Expired deployments acknowledge schedules before connecting to SQL.
  Queued deliveries can still consume function allowance until owner shutdown.

The SQL step receipt and Alchemy writes are separate transactions. A crash between
them deliberately leaves a pending intent; neither a later schedule nor lease
expiry silently clears it. The #34 adapter proves rollback and stale-writer fencing;
this fixture does not claim remote OCI recovery, exactly-once side effects or an
automatic repair of ambiguous operations.

## Reproduce local checks

- `pnpm build:checkpoint` builds the official Neon ZIP without reading credentials.
- `pnpm test` covers HTTP admission, expiry and credential rejection.
- On a fresh loopback PostgreSQL 17 fixture, run `pnpm test:setup-db` once, then
  `pnpm test:checkpoint-db`. The latter installs/removes only its own fresh proof
  schema and exercises real Alchemy, durable receipts, duplicate delivery,
  terminal no-ops, permission denials and unresolved-intent refusal.
- `pnpm test:fenced-db` covers the same lifecycle module and the adapter fault suite.
- `pnpm check` remains cloud-independent; CI additionally builds the checkpoint
  and executes its SQL integration test.

## Bounded live procedure

1. Require the existing dedicated Ohio project, restricted `berth_runtime` file,
   current Free allowance headroom, and empty temporary function/trigger inventory.
   Keep the API key and owner connection outside the repository and runtime.
2. In the owner SQL Editor select the intended branch, `neondb`, `neondb_owner`.
   Run `sql/fenced-state.sql`, then `sql/checkpoint.sql`, once each. Both refuse
   replacement. If an outcome is uncertain, inspect before any further setup.
3. Build `dist/checkpoint.zip`. Deploy to `berthcheckpoint6` and optionally an
   independent evidence reader `berthcheckpoint6b`. Use `deploymentEnvironment`:
   override BOTH database URLs, disable unused injected service credentials, set
   the private bearer, exact ZIP SHA-256 and expiry at most 20 minutes ahead.
4. Confirm deployment IDs and the responding digest. Missing bearer and a forged
   `X-Neon-Trigger-Invocation-Id` envelope must both receive 401. Initial evidence
   must show no events, no records, terminal false.
5. Create one schedule targeting `berthcheckpoint6`, path `/scheduled`, cron
   `* * * * *`, enabled true. Save its returned ID privately before exiting the
   initiating process. Make no client requests for at least two scheduled ticks.
6. Read `/evidence` from the second deployment. Require two completed events with
   increasing generations, preserved start/completion timestamps, terminal true
   and zero state records. Its boot ID must differ from the recorded worker.
7. Disable the recorded trigger, confirm disabled, then delete it and both owned
   functions. List functions/triggers again and require zero trial resources.
   After deployments are gone, inspect released/empty SQL state and save evidence;
   remove this disposable `berth_state` schema only after a terminal result.
8. Preserve the private intent journal on failure. Never replay management writes,
   change the slug to bypass a failure or drop unresolved state. Expiry stops work,
   not billing; administrative schedule/credential shutdown remains an owner task.

The accelerated one-minute cadence proves continuation, not a four-hour soak test.
No local worker, tunnel, proxy, timer or callback drives the two lifecycle steps.
A powered-off-laptop test is distinct: the recorded proof establishes absence of
an initiating client during scheduled execution, not a physical power-off event.

## OCI API checkpoint (no service mutations)

Inspected pinned `oci-objectstorage` **2.146.0** declarations and request assembly:

| Requirement | SDK exposure | Remaining live evidence |
| --- | --- | --- |
| Bucket ownership marker at create | `CreateBucketDetails.freeformTags` serialized in create body | Read back marker, identity and private configuration |
| Object marker at upload | `PutObjectRequest.opcMeta` serialized as `opc-meta-*` headers | Read metadata against a consistent revision |
| Create-only object upload | `ifNoneMatch: "*"` becomes `if-none-match` | Demonstrate rejection of existing object; never fall back to overwrite |
| Conditional object delete | `DeleteObjectRequest.ifMatch` becomes `if-match` | Demonstrate mismatch rejection and owned revision deletion |
| Conditional empty-bucket delete | `DeleteBucketRequest.ifMatch` becomes `if-match`; API requires empty bucket | Demonstrate stale revision rejection and nonempty refusal |

SDK methods select default retry policies unless explicitly overridden. Provider
implementation must disable implicit retries or reserve every actual dispatch.
Header availability is not evidence of actual tenancy authorization or service
behavior. A mismatch/unknown outcome must stop unconditional deletion. This remains
a live gate in the later isolated OCI trial, not a reason to weaken ownership.

## Four-hour allowance and timing assessment

The proposed cadence yields 16 ordinary ticks in four hours (reserve 17 if admitting
both interval endpoints). Creation ends by minute 30; starting cleanup at hour three
leaves roughly four scheduled opportunities before expiry. The measured synthetic
steps below are far shorter than 15 minutes. OCI latency and delayed/missing metric
samples still need measurement; no scheduler delivery deadline or cleanup SLA is
assumed. Never wait until the last tick to start deletion.

For planning, reserve up to **48 work invocations at 60 seconds each**: 0.8 function
capacity-hours if all time is classified active (8% of the published 10-hour Free
active allowance). This is a proposed application budget, not a scheduler retry cap
or a measurement of OCI work. Cold starts, failed loads, diagnostic calls, retries
and expired no-op deliveries need additional headroom and counting. Owner shutdown
is necessary; no finite lifetime invocation cap is claimed while a schedule remains.
At the maximum 2 CU, a continuously awake four-hour database costs at most 8 CU-hours
for that endpoint, before other activity. Lower size/scale-to-zero may reduce this;
do not assume it without measurement. The adapter stores at most two bounded state
records, two proof receipts and 128 claim IDs; database/history overhead is additional.

Current published Free allowances: 100 Postgres CU-hours and 1 GB storage per project,
10 active/400 waiting function capacity-hours, one million invocations and 5 GB public
transfer per project. Functions and Postgres have separate meters. These estimates
are comfortably below an otherwise unused plan, but current account headroom is
not established by unchanged/delayed project counters. No upgrade, prepaid-credit
service or hard spending cap is assumed. Recheck owner-attested Free status and
aggregate usage before the later OCI mutation gate.

Sources checked 2026-11-13:

- [Neon pricing](https://neon.com/pricing) and [plan/function metering](https://neon.com/docs/introduction/plans).
- [Trigger attestation, duplicates and retries](https://neon.com/docs/compute/functions/triggers/overview).
- [Schedule configuration and shutdown](https://neon.com/docs/compute/functions/triggers/schedule).
- [Runtime lifecycle and limits](https://neon.com/docs/compute/functions/reference/runtime-limits).
- [OCI 2.146.0 PutObject contract](https://docs.oracle.com/en-us/iaas/tools/typescript/latest/interfaces/_objectstorage_lib_request_put_object_request_.putobjectrequest.html)
  and [DeleteBucket API](https://docs.oracle.com/en-us/iaas/api/#/en/objectstorage/20160918/Bucket/DeleteBucket).

## Live evidence — 2026-11-13 UTC

| Observation | Result |
| --- | --- |
| Region / hosted runtime | Existing Ohio project; Node 24.22.1 (`nodejs24` platform patch) |
| Pinned engine | Alchemy 2.0.0-beta.86 / Effect 4.1.4 |
| Missing bearer / forged trigger at public edge | Both 401; no proof events before enabling schedule |
| Initiating client exit | 15:59:36.743; setup process completed with no worker/timer left running |
| Scheduled create | 16:00:00.993–16:00:01.072; generation 1, durable receipt completed |
| Scheduled reload/update/destroy | 16:01:00.725–16:01:00.824; generation 2, durable receipt completed |
| Next client request | After 16:02:21, from independent reader function; terminal true, records 0 |
| Independent instance evidence | Reader boot ID differed from both recorded work receipts |
| Owner SQL inspection | Generation 2, released ownership, zero records, two retained claims |
| Shutdown | Disabled trigger confirmed; deleted trigger and both functions; inventories zero |
| SQL disposal | Terminal receipt checked, then disposable proof schema removed |
| Secret log check | 37 returned log records, not truncated; no exact match of known API key, runtime password, URLs or bearer |

The scheduled bundle SHA-256 was
`9ab1fa690df2379cb9c36b877c4b256e614c447fea94e131a4d1d7ee07d126ce`.
The final source extracts the same credential guard for direct unit testing. With
the schedule disabled, the reader was explicitly redeployed and returned matching
final digest `fcf507ff1203c45fb4a586e1bf83088ac16a58931344ad56a89e11f4e32597db`
and the same terminal receipts from a fresh boot. There was no replay of scheduled
mutations for this verification. Initial ZIP 127,576 bytes; final ZIP 127,600 bytes.

The 79 ms / 99 ms intervals above cover intent-to-completion database timestamps,
not full billed invocation time. Reader handler times were 39 ms and 29 ms, with
roughly 71–74 MiB RSS; cold-start and platform overhead are excluded. Project-wide
counters stayed `cpu_used_sec=0`, `data_transfer_bytes=15435`, and
`data_storage_bytes_hour=0`. They are delayed counters and cannot prove zero usage,
current Functions allowance headroom or a billing guarantee.

Local verification: 67 application tests, 16 harness tests, the checkpoint SQL
suite and fenced-state fault suite passed. The expiry mutation test deliberately
removed the elapsed-expiry guard and failed; restored source passed. Secret scan,
strict types, lint and bundle checks passed. Existing dependency audit findings
remain seven moderate and one low, with no high/critical findings.

**Gate status:** hosted synthetic execution, persistence, restricted credentials,
trigger authentication and client-independent completion pass. The four-hour
schedule is plausible by the explicit estimates above, not yet a soak-test result.
The next implementation issues may proceed. Enabling actual OCI mutations remains
blocked until dated account/headroom evidence and the provider's conditional
mutation/reconciliation tests satisfy SPEC.md. This checkpoint does not close those
later acceptance criteria or declare the complete OCI trial successful.

The private journal contains 21 management requests and five manual function
invocations. Owner bootstrap/inspection/disposal used six additional management
reads to obtain the existing endpoint/owner connection. Provider-scheduled calls
are separate from these client counts. Administrative cleanup completed at
16:06:32.685 UTC. No OCI request or paid-plan change was made.


## Live OCI activation checkpoint — 2026-11-14, issue #14

PR #49 completes the hosted admission prerequisite, including protection of cleanup
capacity and evidence freshness through the creation window. The earlier synthetic
result above still does not establish real OCI lifecycle feasibility.

Current read-only checks pass for OCI access and restricted Neon SQL permissions;
the project has no functions/triggers or installed trial schemas. Fresh owner Free
eligibility, aggregate allowance headroom and effective-IAM review remain missing.
**Decision: no-go for activation until those inputs are supplied; live feasibility
is unproven.** No paid fallback or relaxation of resource/request/time limits is
approved. The bounded next step is to complete those inputs and execute the existing
runbook under issue #14, not to introduce another execution backend.

See [the dated live evidence ledger](live-results.md) for observations, build
identity, each unresolved acceptance row and the conditions for resuming. No live
OCI resource lifecycle was started in this checkpoint.
