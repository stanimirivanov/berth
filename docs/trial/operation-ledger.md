# Operation ledger — issue #7

## Boundary

`migrations/001_trial.sql` installs a separate `berth_ledger` schema owned by
`neondb_owner`. It does not reuse the synthetic Alchemy state schema or issue #6
proof receipts. `src/trial/ledger.ts` is a thin parameterized SQL port with no
provider SDK, DDL, automatic retry or local queue. No cloud deployment or provider
call is part of this issue.

The owner runs the migration once in the dedicated `neondb` database, after the
restricted `berth_runtime` role is configured. An existing schema causes failure;
do not replace/drop it or adopt partial work to bypass that guard. Runtime receives
schema usage and EXECUTE on reviewed functions only, with no table access, CREATE,
private-fence execution or migration privileges. PUBLIC execution is revoked and
all function search paths are fixed to `pg_catalog,pg_temp`.

## Contracts

- `start(intent)`: supply a stable operation UUID, compartment OCID, OCI region,
  namespace, SHA-256 content digest and explicit Monitoring/Neon limits. SQL
  generates a random ownership marker, deterministic bucket name, fixed object
  name `trial.bin`, server start and exact four-hour expiry. Matching repeats
  observe existing intent; changed intent is rejected. A locked gate and unique
  index enforce one active or needs-reconciliation trial. Terminal history remains.
- `claim(operation, executionUuid, ttl)`: use a fresh UUID for each execution.
  TTL is 1–60 seconds. The returned claim is frozen; all guarded calls include its
  generation. Repeating that execution's still-live acquisition observes the same
  claim without extending it. Expired execution IDs cannot reacquire. `renew`
  extends only a live lease by 30 seconds; `release` erases no history.
- `begin(claim, attemptUuid, action)`: commits an action attempt before any request.
  Each fixed action permits at most three attempts. A crash before reservation
  still spends the attempt. A mutation attempt cannot dispatch from a new
  generation. Read-only observation/Monitoring/Neon attempts may span generations;
  resume their stable ID instead of starting a new attempt for each observation.
- `reserve(claim, attemptUuid, requestUuid)`: reserves exactly one underlying
  request atomically with an unresolved dispatch intent. Only `fresh: true`
  authorizes the caller to dispatch once. A repeated ID returns `fresh: false`,
  including after a lost response; it is evidence, not permission to send again.
  Mutations permit only one request per attempt, even after a definite rejection.
  Retrying a failed mutation requires a new bounded attempt. Read-only attempts
  may reserve separate pages/observations; each consumes a new request slot.
- `settle(...)`: only definite `succeeded` or `rejected` outcomes are admitted.
  Timeout, connection loss, ambiguous 5xx or an absence check cannot be treated as
  definite rejection of an in-flight mutation. A new generation must explicitly
  use independently established `reconciled-provider` evidence, not pretend it
  received the old generation's response. The basis and resolving generation persist.
- `end(...)`: close an attempt only after all its request outcomes are definite.
  `finish(...)`: terminal success/failure requires closed attempts and no unresolved
  requests. Known successful provisioning additionally requires successful bucket
  teardown. `needs-reconciliation` retains the active-trial slot and disables new
  creation; it is not terminal permission to start another trial.
- `read(claim)` returns active fenced evidence. Repeating the exact `start` intent
  can inspect the stored trial row after terminal completion; owner diagnostics can
  inspect retained attempts/requests. This is not yet an HTTP status API.

An unresolved mutation blocks all new mutating dispatches, including cleanup,
regardless of lease expiry. Read-only reconciliation remains possible within its
budget. SQL fencing cannot cancel an external request already in flight: later
provider code must establish completion, ownership and revisions before resolving
it. The trusted runtime supplies this evidence; a string enum is not independent
proof that OCI honored a precondition. Never expose settlement directly to user
request data. This ledger is not isolation from a malicious holder of its runtime
credentials.

Use bounded **autocommit** connections (connection and server statement timeouts).
Never dispatch on a reservation made inside a still-open application transaction.
The wrapper does not commit caller-owned transactions. A lost SQL response is
uncertain; inspect stable IDs instead of repeating the external request. Do not
clear unresolved intent on expiry or reset counters to recover quota.

## Budget ownership

| Action | Request allowance |
| --- | --- |
| `create_bucket`, `put_object`, `inspect` | 160 normal Object Storage requests |
| `delete_object`, `delete_bucket`, `inspect_cleanup` | 40 protected cleanup Object Storage requests |
| `monitor` | Separate explicit Monitoring request limit |
| `invoke` | Separate explicit admitted Neon-work limit |

The action fixes its meter; callers cannot select a budget label. No unused cleanup
capacity can be borrowed by normal work. Every uncertain dispatch remains spent;
no settlement refunds it. All counters and reservations commit under the same
trial row lock. Monitoring/Neon limits must be explicitly selected from measured
headroom (positive integers capped at 1,000 by this migration); 12 and 48 are test
fixtures, not provider allowances or billing estimates.

Neon work admission happens after a function has already been invoked. It cannot
count or prevent platform retries, rejected requests or expired no-op invocations
before database access. Provider usage tracking and headroom checks must measure
those separately. Disable implicit SDK retries: every actual request, page and
retry needs its own reservation. A retry of an action also consumes a new action
attempt. Later provider wiring must choose the correct fixed action and must not
mislabel general reads as cleanup.

SQL rejects new create/upload attempts and dispatches after minute 30, after cleanup
begins, or while needs-reconciliation. All new dispatches stop at four-hour expiry.
The later scheduler must initiate cleanup by hour three; this ledger does not
schedule work. Expired trials remain active until their outcome is reconciled.
Recording already-established outcomes is separate from permission to send more
cloud requests. No hard spending cap is claimed.

## Verification and recovery evidence

On a fresh loopback-only PostgreSQL 17 fixture:

1. Set `BERTH_TEST_POSTGRES_PORT` to the disposable port.
2. Run `pnpm test:setup-db` once to create the owner/runtime fixture roles.
3. Run `pnpm test:ledger-db`; only its newly created ledger schema is removed.
4. Run `pnpm check` for unit tests, types, lint, harness and secret checks.

Real SQL tests race trial starts, leases and reservations across connections; 180
normal reservations yield exactly 160 successes, and 60 cleanup reservations yield
exactly 40. Separate telemetry meters exhaust independently. Tests also cover stale
settlement, retired attempts, immutable intent, expiry windows, permissions,
terminal teardown requirements and a lost successful SQL response.

Actual backend termination is injected after attempt creation but before reservation,
after reservation inside an uncommitted transaction, and after reservation commit.
The first spends only the attempt, the second rolls back the request charge, and the
third retains a spent unresolved request that blocks conflicting mutations and
terminal success after takeover. No cloud behavior is inferred from these tests.

Verification on 2026-11-13: all four real PostgreSQL integration cases, 69 application
unit tests and 17 harness tests passed. Deliberately increasing the normal ceiling
to 161 made the race test fail; restoring 160 passed. Canonical lint/types/build,
secret scan and audit gate passed (existing seven moderate/one low advisories).
The disposable local database was removed. This migration has not been installed
on Neon and no provider requests or account changes were made.
