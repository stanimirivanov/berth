# Read-only operation history — issue #87

Operation History reads stored evidence through the application-owned
retained trial ledger adapter. Historical **partial/no-go** feasibility
remains. A stored `succeeded` outcome does not prove all live validation
criteria.

## Install and consume

- Migration `008_operation_history.sql` requires the dedicated `neondb_owner`
  connection to `neondb` after migrations 001/002. Before a separately approved
  History cutover, create the login as a PostgreSQL administrator with
  `CREATE ROLE berth_history_runtime LOGIN NOINHERIT;` and set its password
  with the interactive `psql` command `\password berth_history_runtime`. Use a
  fresh independent password. Give the login zero role memberships, including
  managed administrator roles. Apply `013_history_reader.sql` as `neondb_owner`
  after 008 to grant schema usage and the two projection calls.
- Set both `DATABASE_URL` and `DATABASE_URL_UNPOOLED` to the same direct
  `berth_history_runtime` connection URL for `neondb`. Keep the URL in secret
  bindings. The adapter verifies TLS and enforces SCRAM channel binding when
  the URL specifies `channel_binding=require`. It checks the authenticated login
  and effective privileges in a bounded read-only transaction before each query.
  The login needs database CONNECT and cannot have CREATE or TEMP privileges,
  application table privileges, or any extra callable non-system SQL routine.
- `historyReader(env).list()` returns `{ items, next }`, default 20 records,
  maximum 50. Rows sort by start timestamp descending, then operation UUID
  descending. Pass `next` as the next call's `before` cursor. The cursor is the
  last included operation only when another row exists. Unknown/malformed cursors
  and invalid limits fail closed; there is no silent restart or offset scan.
- `historyReader(env).detail(operation)` returns the same allowlisted record, or null when
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

The dedicated login can execute the bounded page and detail SECURITY DEFINER
entrypoints. PostgreSQL denies the private projection, direct application table
access and executor calls even in a read-write session. Fixed search paths and
schema-qualified relations protect the queries. Indexes support the keyset order
and per-operation request counts.

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
read-only transactions, UUID tie-break pagination, expired and
needs-reconciliation records, nullable phase, redaction, invalid input and
unchanged durable evidence. A real dedicated login in a read-write session must
be denied direct reads and writes, temporary tables, private and executor
functions, and switching to the trial role. The adapter rejects role membership,
column grants, a PUBLIC executor grant and missing projection grants.
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
