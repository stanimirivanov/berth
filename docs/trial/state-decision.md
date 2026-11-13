# Durable state qualification — blocked

Issue #5, 2026-11-13. **No durable backend is approved.** The selected first
candidate, Alchemy's native Postgres store on the existing Neon Free project,
fails local prerequisite checks. This is the bounded blocked outcome permitted
by #5, not a successful hosted trial. #6 must not authorize OCI lifecycle work
on the strength of this PR. Closing the investigation does not clear that gate.

## Candidate and exact interface

- Alchemy and `@alchemy.run/sql`: `2.0.0-beta.86`; `@effect/sql-pg`: `4.1.4`.
  The two additional packages are test-only development dependencies.
- Documented interface: [`postgresState`](https://alchemy.run/state-store/#postgres-state-store).
  Qualification uses its exported `makePostgresState(options, scope)` constructor,
  the `StateService` interface, and a caller-owned `PgClient.make` pool.
- Exact installed implementation references: `@alchemy.run/sql/lib/PostgresState.js`
  (`migrate`, `acquireLease`, `guarded`, `set`), its adjacent `.d.ts`, and
  `alchemy/lib/State/StateEncoding.js` (`encodeState`). The lockfile pins artifacts;
  online documentation may describe a newer release.
- Four connections per test pool, direct PostgreSQL sessions, five-second connect
  and statement timeouts, `leaseCheckTtlMs: 0`. A transaction-pooler URL is unsuitable
  for session advisory locks. A single-connection pool is also unsuitable.

## Evidence and verdict

Real PostgreSQL 17, Node 24.22.3, disposable loopback container, no cloud calls.
The initial acceptance assertion that CRUD-only runtime startup succeeds failed
with SQLSTATE `42501`. The stale-write rejection assertion also failed: the write
committed. The committed suite characterizes those defects so a future version
change forces reassessment; **green here means reproduced, not safe**.

| Check | Observation | Acceptance |
| --- | --- | --- |
| Owner bootstrap + runtime USAGE/CRUD only | First store operation fails with `42501`, despite both tables already existing | Blocked |
| Ordinary concurrent stores | Second pool refuses the held stage lock | Local control passed |
| Close/reopen pool and CRUD | State survives a new pool; update/delete work | Local control only; not fresh processes |
| Constraint-rejected write | Prior committed value survives | Local atomic-write control passed |
| Lost lock during in-flight write | Old writer overwrites the newer owner's value | Blocked |
| Synthetic `Redacted` canary | Actual canary appears in JSONB | Credentials must never enter state |
| Independent deployed Neon invocations / process death | Not attempted after local blockers | Unverified |
| Real Alchemy resource lifecycle using this backend | Not attempted; tests call the actual StateService API | Unverified |

The positive controls deliberately grant schema CREATE to the **disposable local
fixture role only**. They do not prove Berth's restricted runtime works. Neither
Neon grants nor the deployed runtime were changed.

### Root causes

1. Every fresh store runs a migration before its first read or write. PostgreSQL
   checks schema CREATE permission for `CREATE TABLE IF NOT EXISTS` even when the
   owner already created the table. There is no documented skip-migration option
   in the pinned constructor. Running with the owner URL or broadening the existing
   runtime role would evade the approved boundary, not validate it.
2. Lease validation and the mutation use a different session from the reserved
   advisory-lock session. The lease can disappear after validation but before the
   mutation commits. Disabling the validation cache does not close that gap.
   Reproduction: pause A's INSERT in an owner-installed test trigger, terminate
   only A's lock session, commit B's new value under its newly acquired lock,
   then release A. A commits stale state; its next operation finally detects the
   lost lease. The trigger is fault injection, not a proposed deployed component.
3. `Redacted` protects display, not serialization: Alchemy encodes its inner value
   into state. This is not a generic secret scanner or encryption boundary.
   Credential-free props, attributes, outputs and replacement history must be
   enforced before persistence, including nested values and failure paths.

## Repeat the bounded local experiment

Use an otherwise disposable PostgreSQL 17 container. Do not point this suite at
an existing development database. It accepts a loopback port only, fixed database
`neondb`, user `postgres`, and test-only password `berth-test-only`.

```bash
container_id=$(docker run --detach --rm \
  --publish 127.0.0.1::5432 \
  --env POSTGRES_DB=neondb --env POSTGRES_USER=postgres \
  --env POSTGRES_PASSWORD=berth-test-only \
  postgres:17@sha256:846a7ddaa67a4b354ae1d21087b683901aa6113a4ed626d3787cfbf6c85e3e07)
docker exec "$container_id" pg_isready -U postgres -d neondb
# Repeat pg_isready if startup is not yet complete, then:
trial_port=$(docker port "$container_id" 5432/tcp | sed 's/127.0.0.1://')
BERTH_TEST_POSTGRES_PORT="$trial_port" pnpm run test:state-db
# Always remove this disposable container after inspection, including on failure:
docker stop "$container_id"
```

The suite refuses existing fixture names, removes only its own schema/role, closes
pools, and bounds fault synchronization to 100 observations. CI runs the same
command after the existing database permission suite. It reads no private files,
accepts no remote hostname and never calls OCI. Raw errors are safe only because
this is a synthetic local fixture, not a credential-bearing diagnostic command.

## Free allowance and proposed lifecycle

If a corrected Postgres backend is later approved, reuse the existing dedicated
Neon project; do not add a branch or endpoint. [Neon pricing](https://neon.com/pricing)
checked 2026-11-13 lists 100 CU-hours/month and 1 GB storage per project, five-minute
idle scale-to-zero, and Functions allowances of 10 active/400 waiting capacity-hours
and 1 million invocations per project. These are shared with all trial activity,
not a new allowance for state. Console plan/headroom verification remains necessary.
No account usage was measured in this investigation.

- Proposed state budget: one stack/stage, at most 10 resource records, 16 KiB per
  record, 256 KiB combined logical payload. These are planning bounds, not current
  enforcement or an estimate of indexes/WAL/history overhead.
- Bootstrap separate owner-held state tables/schema with a local owner connection;
  inject only a narrowly granted runtime URL into the function secret environment.
  Keep the direct URL private and close its pool after each bounded invocation.
- IaC state identifies resources and recovery ownership. Operation/request budgets,
  metrics and warning deduplication belong to separate ledger tables under #7/#12.
- Retain state until remote teardown and ownership reconciliation finish. Revoke
  runtime access and delete state only at owner closeout; loss of state is not proof
  that infrastructure is gone. Include state in the backup/recovery decision.
- Proposed warnings at 50% and 80% of remaining shared allowances must precede later
  work; missing usage evidence stops new provisioning. This PR implements no usage
  collector or spending cap. Never enable a paid plan to pass qualification, and
  do not treat application warnings as an account-wide hard cap.

## Alternatives and bounded next decision

This result rejects the pinned Postgres implementation, **not every free backend**.
The next decision belongs to #6; a successful alternative still needs #5's hosted
proof before the feasibility gate can pass.

| Option | Current disposition |
| --- | --- |
| Local/in-memory state | Cannot survive independent hosted processes |
| Native Postgres on Neon Free | Two reproduced blockers above; no deployment |
| Native Cloudflare state | Credible next candidate; needs account/bootstrap and its own concurrency/Neon proof |
| AWS/GCP stores | Require additional accounts, credentials and allowance review; not qualified |
| Custom narrow Postgres store | Estimate below only; not implemented or approved |

Cloudflare's documented store uses a Worker, SQLite Durable Object and Secrets
Store. [SQLite Durable Objects are available on Workers Free](https://developers.cloudflare.com/durable-objects/platform/limits/).
That does not establish the complete Alchemy bootstrap's free-plan compatibility,
account headroom, Neon authentication or concurrency safety. Validate all supporting
resources before provisioning; do not infer that unavailable account access means
Cloudflare is technically unsuitable.

Prefer qualifying an upstream correction or Cloudflare's existing store before
owning a custom backend. If a custom Postgres adapter is chosen, estimate **4–7
engineering days plus review and provider propagation time**, split into these
bounded tasks (estimate, not a promise):

1. **1 day:** define the exact pinned `StateService` contract, fixed stack/stage,
   payload limits, schema version, owner migration and CRUD-only role grants.
2. **1–2 days:** implement atomic ownership and mutation fencing in PostgreSQL;
   reject stale generations in the same transaction as state writes. Define
   contention, release, expired-owner reconciliation and uncertain-commit behavior.
3. **1 day:** reject credentials with a closed trial payload schema; keep provider
   credentials outside state, including outputs and replacement chains. Add
   bounded queries and safe error classes, not a generic state API or service.
4. **1–2 days:** independent-process CRUD, simultaneous access, killed sessions,
   failure before/after commit, uncertain replies, atomic stage deletion and grant
   denials. A lease cannot cancel an already dispatched OCI request; #13 remains.
5. **1 day:** deploy an authenticated synthetic-only Neon probe using restricted
   credentials, prove fresh invocation persistence and shutdown, record usage and
   remove the probe. No OCI writes.

Stop and re-estimate if this requires a general lock service, arbitrary stacks,
credential encryption/key management, schema-owner runtime, or a paid plan. No
`src/trial/state.ts` or `neon.ts` integration is shipped until a backend passes.
