# Hosted OCI trial — issue #14

## Status on 2026-11-14

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
