# Read-only operation history — issue #87

Operation History reads stored evidence through the application-owned
retained trial ledger adapter. Historical **partial/no-go** feasibility
remains. A stored `succeeded` outcome does not prove all live validation
criteria.

## Install and consume

- Migration `008_operation_history.sql` requires the dedicated `neondb_owner`
  connection to `neondb`, after migrations 001/002. Installation is an explicit
  owner action; this PR installs nothing on Neon and changes no historical rows.
- Use a restricted `berth_runtime` connection with a session statement timeout
  established **before** queries and a client/network deadline. The shared SQL
  port assumes bounded connections; function-local settings alone are not a hard
  end-to-end deadline. The History HTTP handler uses this adapter within a
  read-only transaction.
- `retainedHistoryLedger(db).list()` returns `{ items, next }`, default 20 records,
  maximum 50. Rows sort by start timestamp descending, then operation UUID
  descending. Pass `next` as the next call's `before` cursor. The cursor is the
  last included operation only when another row exists. Unknown/malformed cursors
  and invalid limits fail closed; there is no silent restart or offset scan.
- `retainedHistoryLedger(db).detail(operation)` returns the same allowlisted record, or null when
  absent. Neither method checks execution expiry or creation headroom. There is
  no new execution authorization or cleanup bypass.
- An empty page is `{ items: [], next: null }`. Missing executor work produces a
  null phase; it does not assert that the bucket phase ran. Other flags preserve
  the existing absent-work false defaults.

## Evidence and privacy boundary

Each record contains only operation UUID, start/expiry timestamps, stored outcome,
nullable phase, pending-upload/cleanup/object-removal flags, app spent/limit
counters, unresolved request/mutation counts, and `verdict: "partial"`.
Application counters are **not provider usage or remaining free allowances**.
No raw reason, provider/credential identity, target names, ownership tags,
receipts, request payloads or Alchemy state is exposed.

The SQL private projection is not granted to runtime or PUBLIC. Only the bounded
page and detail SECURITY DEFINER entrypoints are granted to runtime; all table
access remains denied. Fixed search paths and schema-qualified relations prevent
caller objects from substituting for protected data. Indexes support the keyset
order and per-operation request counts.

Pagination is a browsing view, not a cross-request immutable snapshot: later
outcome/counter changes may appear on later reads. New records may appear ahead of
an existing cursor. Summaries do not claim provider absence or settle unknown
mutations. The History HTTP handler owns authentication. Keep this SQL adapter
server-side. See [ADR 0010](../adr/0010-separate-application-from-trial-execution.md).

## Verification

```bash
pnpm build
node --test dist/tests/operation-history.test.js
BERTH_TEST_POSTGRES_PORT=YOUR_LOOPBACK_PORT pnpm test:admission-db
pnpm check
pnpm build:live-executor
```

Use a fresh disposable PostgreSQL fixture initialized by `test:setup-db`.
The history regression is included in the existing admission CI gate. It checks
restricted read-only transactions, UUID tie-break pagination, expired and
needs-reconciliation records, nullable phase, redaction, invalid input, private
function/table denial, PUBLIC ACLs and unchanged durable evidence before/after.
No live credentials, cloud resources or new trial are needed. Independent owner
cleanup and the historical 160/40 reserve remain separate and unchanged.

Local verification passed: the store regression, all 13 admission SQL tests, and
`pnpm check` with 179 application and 30 harness tests, lint/types, architecture/docs
checks, secret scan and unchanged dependency audit gate. The live executor archive
built locally without deployment. Seven moderate and one low advisory remain;
no high/critical findings were reported.

## Angular follow-up — issue #89

The owner requested an Angular history UI after this backend slice. The dependent
[UI and read-service guide](../../ui/README.md) documents the first screen, private
same-origin API and independent function bundle. Its browser tests use synthetic
records only. No live migration or deployment follows automatically from either PR.
