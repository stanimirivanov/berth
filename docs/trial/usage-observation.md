# Bucket usage and warning history

Issue #12 adds a bounded observation phase and private usage report. It answers:

- Did this bucket emit fresh post-upload data, and when was it observed?
- Has its stored size reached the app's demonstration warning threshold?
- Is missing evidence due to an unobserved window, and can cleanup still finish?

## Contract and limits

Only `StoredBytes`, `ObjectCount` and `AllRequests` in `oci_objectstorage` are
queried, filtered by the persisted bucket OCID. Response namespace, compartment,
bucket ID/name and Standard tier must match; ambiguous streams are unknown.
Standard tier spelling is case-normalized, never combined with Archive.
`AllRequests` has no tier dimension and is an operational hourly count, not a
billing ledger, month-to-date total, or full-account measurement.

The app threshold is **2 MiB**, warning at **>= 50% (1 MiB)**. This is a durable
in-app warning, not a provider spending cap, storage quota, email or notification.
It does not mean the account is close to its free allowance. The API explicitly
reports `providerHardCap: false` and `coverage: bucket-operational-not-billing`.

[OCI's metric definitions](https://docs.oracle.com/en-us/iaas/Content/Object/Reference/objectstoragemetrics.htm)
state that the two storage gauges are hourly and empty buckets emit no data.
The collector uses one-hour maximum gauge windows and one-hour sums for requests.
[Monitoring timestamps describe aggregation window ends](https://docs.oracle.com/en-us/iaas/Content/Monitoring/Concepts/monitoringoverview.htm),
so a source timestamp must be at least one full hour after verified upload. This
conservative rule excludes windows containing pre-upload time. A source must also
be no later than observation and at most 90 minutes old. Delayed data can become
usable at the next hourly poll; no busy polling or synthetic zero fills occur.

Each metric stores `sourceAt`, `observedAt`, `status` and `value`. Missing, stale,
future, wrong-target and malformed data are `unknown`, with null value/source.
A real measured zero remains a known zero. Every poll's observation time survives
cleanup. Source windows are not added together into a cumulative request total.

## Execution and recovery

1. The owner installs `migrations/003_usage.sql` after 001/002 in the dedicated
   database. The sequence number differs from the original issue sketch because
   002 already belongs to the executor. Do not rerun migrations after an uncertain
   commit; inspect installed schema first. Runtime has function grants only.
2. With `ExecutorOptions.usage` configured, verified upload records the server time
   once and enters `observe`. The first poll is due one hour later. A row-locked
   admission advances the next due time one hour before any request, including if
   that process later crashes. Missed hours are not replayed in a burst.
3. Inject `monitoringTransport(region, compartment, restrictedSigner)` as that
   transport. Each of the three underlying calls reserves the separate `monitor`
   meter. Reads share the existing bounded open attempt; failures never refund
   requests. No SDK retries, pagination following or unmetered fallback exists.
4. Every send rechecks ownership, cancellation, phase and hour-three cutoff, also
   after SQL renewal. The transport honors the execution/cleanup deadline, limits
   each request to five seconds and caps response bodies at 64 KiB.
5. Successive authenticated scheduler ticks collect only when due. Cancellation,
   failure or hour three takes precedence. Cleanup closes the metric window and
   preserves observations/warnings. Budget exhaustion records unknown evidence;
   it cannot consume cleanup allowance or postpone required cleanup.
6. Warning insertion is unique per operation. Identical poll replay is idempotent;
   conflicting replay rejects. SQL checks freshness and the TypeScript threshold
   decision independently under the same immutable generation fence.

A complete fresh three-metric observation is `observed`. While active, stale or
missing latest evidence is `unknown`; after the window closes it is `inconclusive`.
Closed history remains historical evidence rather than becoming a current usage
claim. A successful resource teardown can coexist with inconclusive usage; the
complete trial is not thereby proven. Deletion does not reset accrued usage.

The legacy executor mode without a Monitoring transport retains immediate teardown
and produces no usage evidence. The hosted synthetic root supplies an empty metric
fixture, enters observation and always reports missing usage truthfully. It cannot
use OCI credentials. Real signer deployment remains gated by #13/#14.

## Private API

Use the existing authenticated POST API, `Content-Type: application/json`:

```text
POST /usage
Authorization: Bearer <private trial token>

{"operation":"<accepted operation UUID>"}
```

The route checks authentication and exact body shape before reading SQL. It validates
that the operation belongs to the configured target, skips creation-headroom checks,
and never contacts OCI. Responses use `Cache-Control: no-store` and include the
threshold, upload/window-close times, evidence status, observation history and at
most one warning. The route continues to read retained history after teardown.
It is composed by `executorApi`; no public reporting endpoint or Angular UI is added.

## Warning runbook

- **Meaning:** a fresh bucket gauge reached the app's 1 MiB demonstration boundary.
- **First check:** read `/usage`; inspect the source and observation timestamps,
  target, coverage disclaimer and current owner aggregate allowance evidence.
- **Action:** use the existing authenticated `/cleanup` route if early teardown is
  desired. Unknown evidence is not permission to create more resources. If hosting
  or cloud quotas prevent cleanup, the owner reconciles recorded resources under
  the existing shutdown procedure. No external message is sent automatically.

## Verification and remaining proof

```bash
pnpm check
pnpm build:executor
# Fresh disposable loopback Postgres, initialized by test:setup-db:
BERTH_TEST_POSTGRES_PORT=your_local_port pnpm test:usage-db
BERTH_TEST_POSTGRES_PORT=your_local_port pnpm test:executor-db
```

Tests cover source/observation timestamps, complete post-upload windows, wrong
bucket/tier, missing/stale/future data, real zero, threshold equality, replay
immutability, stale writers, warning retention through actual Alchemy teardown,
private API admission, hourly due checks, budget exhaustion, cancellation and the
hour-three SQL-renewal race. Transport fixtures prove fixed targets, bounded bodies,
pagination refusal and single-send errors. CI runs the new schema suite.

These are local fixture and real PostgreSQL results, not live OCI metric evidence.
No deployment or cloud resource mutation was performed for #12. The metric dimension
contract and ingestion timing still need live qualification in the gated trial;
unknown data must remain inconclusive rather than loosening validation to pass.
