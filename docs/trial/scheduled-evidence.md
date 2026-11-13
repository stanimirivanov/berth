# Scheduled executor qualification — 2026-11-13

Scope: issue #11, existing owner-attested Neon Free project in AWS US East 2
(Ohio), existing restricted `berth_runtime` role. No OCI request, resource, credential
deployment, paid-plan change or external state backend was used.

## Local evidence

- Canonical `pnpm check` passed: strict types, format, architecture/JSDoc sensors,
  application/harness tests, official runtime bundle, secrets and dependency audit.
- The new official `pnpm build:executor` bundle succeeded.
- All 11 executor SQL integration tests passed against disposable loopback Postgres,
  exercising actual Alchemy plan/apply/destroy and owner-installed migrations.
- All five existing ledger SQL tests and all 15 object-provider tests passed.
- Additional focused tests verify exact expiry before credential parsing/connection,
  restricted credentials and aborting delayed signed dispatch/body streams.
- No high/critical audit findings. Existing seven moderate and one low findings
  remain unchanged; this change adds no dependencies.

The independent review found interrupted-read settlement, stable attempt reuse,
protected upload reconciliation and final-dispatch deadline races. The explicitly
approved read-only Codex CLI review additionally found insufficient cleanup retry
margin and signing crossing the creation cutoff. Regression tests failed before
fixes, then passed. One interrupted cleanup download now permits teardown with
normal budget exhausted, using at most all 40 cleanup reservations. Lost deletes
are reconciled without repeating the mutation. Repeated outages are not guaranteed
recoverable inside the finite reserve.

## Hosted procedure

The owner installed migrations 001 and 002 and submitted a synthetic intent through
the real preview/submission composition. Headroom for this intent was explicitly a
fixture, not a live account allowance measurement. Two functions received the same
Node 24 ZIP and restricted environment: one scheduled executor and one independent
read-only evidence endpoint.

Initial deployments failed closed before SQL or provider work because the ambient
password guard was too broad. The corrected guard examines the exact `PGPASSWORD`
variable, permits a disabling marker or a password matching both validated
restricted-role URLs, and rejects unrelated passwords. Neither provider bodies nor
credential values were exposed while diagnosing this. The final deployed bundle is
366,984 bytes, SHA-256:

`3c52cd85180158438a98a3e5e2496e8884e321b8f44ecd6837f03b3a11d01d5b`

Missing evidence authentication and a public forged trigger header both returned
401. The one-minute qualification schedule was enabled, and the initiating Node
process initially exited at **20:04:04.329 UTC**. Those deliveries exposed a
composition defect: `finally` closed the connection before the returned executor
promise settled. A delayed-query regression reproduced the failure; awaiting the
executor before closing fixed it. A restricted-role diagnostic claim was tested
inside a transaction and rolled back. The corrected deployment client exited at
**20:13:15.243 UTC**. No manual execution request drove the state machine after that
exit. The repository's proposed cadence remains 15 minutes,
disabled by default; this accelerated proof is not a four-hour soak test and does
not claim that the physical computer was powered off.

## Hosted outcome and disposal

The independent deployment returned HTTP 200 with `status: succeeded`,
`objectRemoved: true` and no error reason after the corrected client had exited.
The owner's separate SQL inspection confirmed:

| Evidence | Result |
| --- | --- |
| Durable deliveries / invocation reservations | 3 / 3 |
| Normal request reservations | 15 of 160 |
| Cleanup request reservations | 28 of 40 |
| Unresolved requests | 0 |
| Alchemy state | Empty |
| Synthetic bucket / object | Both absent |
| Claim lease | Released/expired |
| Terminal outcome | Succeeded |

The trigger was disabled and read back as disabled, then deleted. Both proof
functions were deleted; fresh inventory showed zero functions and zero triggers.
The owner removed only the two proof schemas after checking terminal state,
absence and unresolved requests. Administrative cleanup completed at
**20:17:06.259 UTC**. The disposable local PostgreSQL container was also removed.

The private journal records 50 bounded management requests (including diagnostics
and owner connection lookups) and nine manual authentication/evidence invocations.
Provider-scheduled deliveries and their earlier failed retries are additional
function executions: the three ledger reservations count admitted executor work,
not all platform invocations. This is not a measurement of total billed usage.
No further cloud request was needed after cleanup. Retained private journal and
receipts contain no unresolved resource intent.

## Limits and next gate

This verifies synthetic continuation using the real API/ledger/Alchemy/provider
path and durable service fixtures. It does not verify OCI IAM, billing headroom,
real storage metrics, usage warnings, or cloud request duration. #12 owns usage
warnings; #13 owns the remaining fault-injection gate; #14 owns the gated real OCI
trial. Unknown mutations remain durable, and an exhausted reserve or expired
operation requires owner reconciliation rather than an invented success result.

Schedule authentication relies on Neon's gateway behavior, checked live above.
See [Neon's trigger documentation](https://neon.com/docs/compute/functions/triggers/overview)
and [environment variables](https://neon.com/docs/compute/functions/environment-variables).
