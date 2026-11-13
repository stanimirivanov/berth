# Narrow fenced Postgres adapter — issue #34

## Decision and boundary

Use the existing Neon Free database for the next synthetic checkpoint. This is a
new adapter, not approval of Alchemy's native Postgres store. The native store and
Cloudflare store failures remain valid. No paid service or additional project,
branch, endpoint, scheduler or OCI resource is needed.

`src/trial/fenced-state.ts` implements the pinned Alchemy StateService through two
owner-installed SQL functions. The runtime role cannot write their tables, change
the schema or execute the private validator. Every state operation locks the same
singleton ownership row, validates its captured owner UUID/generation against the
DB clock, and performs its work in that transaction. Takeover locks that row too.
A write already holding it commits before takeover, or rolls back on connection
loss. A delayed statement from an old generation fails after takeover.

- One stack `berth-fenced-trial`, stage `probe`, resource `synthetic`.
- Fixed synthetic marker values `first` / `second`; at most two state records.
- Resource payload limit 16 KiB; bounded update-history nesting; no bindings,
  actions, replacement states, arbitrary outputs or provider credentials.
- At most 128 acquisitions per bootstrap; lease 1–60 seconds, renewal 30 seconds.
- SQL lock timeout two seconds; callers must supply bounded connection/query
  timeouts and use autocommit, never long-lived application transactions.
- Each execution generates a fresh UUID and captures its generation once. No
  automatic retries, renewal or reacquisition. Runtime credentials are a trusted
  application boundary, not hostile tenant isolation.
- Deleting state does not delete ownership history. A retired execution UUID can
  never acquire again. Never reset that history while an old executor can run.
- A lost acquisition response may be reconciled with the **same execution UUID**
  while its lease is active; it returns the same generation without renewal.
  A fresh process uses a new UUID and waits for expiry before explicit acquisition.
- A lost write response is uncertain. Read committed state through a valid owner;
  do not replay a mutation merely because its response was lost.

This fences database state, not a previously dispatched OCI request. Operation
journals, external ownership/revision checks and unresolved-request reconciliation
remain required in #7–#13. Supporting actual OCI resource payloads needs a separate
reviewed validator extension. This synthetic adapter must not be used unchanged
for OCI resources. Hosted Functions wiring and computer-off execution remain #6.

## Reproduce local verification

1. Start the pinned disposable PostgreSQL service described in the setup guide.
   Use a fresh database `neondb`, user `postgres`, password `berth-test-only`,
   bound only to loopback. Never point this suite at a shared database.
2. Set `BERTH_TEST_POSTGRES_PORT` to its mapped port.
3. Run `pnpm run test:setup-db` once to establish restricted fixture roles.
4. Run `pnpm run test:fenced-db`. The test refuses an existing `berth_state`
   schema, installs its own schema and removes only that newly installed fixture.
5. Run `pnpm check`. CI runs the SQL test after the existing permission tests.

The integration test covers competing claims, stale read/write/delete/renew,
retired UUIDs, lost acquisition/commit responses, direct-write and DDL denials,
credential-payload rejection, takeover blocked behind an uncommitted transaction,
backend termination/rollback, and real Alchemy create/update/destroy.

## Reproduce the bounded Neon proof (explicit operator action)

Do not run these steps as part of CI or against a shared application database.
Budget: one fresh schema, four runtime processes, five claims, two fixed markers;
no automatic retry, deployment or schedules. Stop on any failed step and preserve
state for inspection. Free-plan status and aggregate usage headroom must be checked
in the Neon Console before a future run; these tests do not verify billing or impose
a hard spending cap.

1. Open the existing Neon trial project in Console. Open **SQL Editor**. Select the
   intended branch, database **neondb**, role **neondb_owner**. Confirm these match
   the private runtime file's target. Do not select the runtime role for bootstrap.
2. Paste the complete `sql/fenced-state.sql` file and click **Run** once. It is a
   single transaction and refuses to replace/adopt an existing schema. On an
   ambiguous result inspect `berth_state` before doing anything else; do not rerun
   or drop an existing schema to bypass the guard.
3. Build with `pnpm build`. Use the existing owner-only runtime file (absolute
   path, outside the checkout); do not put a URL or password in command arguments.
4. Run each command below as a separate process, in order:

   ```bash
   node dist/tests/integration/fenced-neon.js first "$BERTH_PRIVATE_DIR/neon-runtime.json"
   node dist/tests/integration/fenced-neon.js second "$BERTH_PRIVATE_DIR/neon-runtime.json"
   node dist/tests/integration/fenced-neon.js fence "$BERTH_PRIVATE_DIR/neon-runtime.json"
   node dist/tests/integration/fenced-neon.js destroy "$BERTH_PRIVATE_DIR/neon-runtime.json"
   ```

   Each must report `result: passed`. `fence` deliberately expires a claim,
   acquires a higher generation and proves old writes/deletes/renewals fail.
   `destroy` must read persisted state before Alchemy teardown, then prove empty.
5. In the owner SQL Editor, inspect:

   ```sql
   SELECT generation, expires_at <= clock_timestamp() AS released,
          (SELECT count(*) FROM berth_state.records) AS records,
          (SELECT count(*) FROM berth_state.claims) AS claims
   FROM berth_state.ownership;
   ```

   A fresh successful run yields generation **5**, released **true**, records
   **0**, claims **5**. Preserve this evidence. Keep history for continued use.
6. For disposal of this proof only: ensure all four processes exited, no hosted
   executor uses this schema, and the preceding checks passed. Then the owner may
   run `DROP SCHEMA berth_state CASCADE;`. Never drop it to recover an unknown
   operation or an active deployment. Dropping it removes the generation history.

## Observed evidence — 2026-11-13

Local PostgreSQL 17: competing claims produced exactly one winner. A transaction
held ownership past lease expiry; takeover remained blocked until its backend was
terminated, rolled back the uncommitted marker and retained the previous marker.
Lost-response simulations reconciled committed state without blind replay.

Live existing Neon database, restricted `berth_runtime`, Node 24.22.3 and Alchemy
2.0.0-beta.86: separate processes created `first` (generation 1), loaded and updated
to `second` (generation 2), rejected expired generation 3 after generation 4 took
over, then loaded and destroyed state (generation 5). Owner inspection confirmed
zero records, released ownership and all five retained claims. This was a live DB
proof from local clients; it was **not** a hosted Functions deployment proof.

No plan upgrade or infrastructure deployment was requested. Neon Free status uses
prior owner attestation; this run does not independently prove current allowance
headroom, billing or scale-to-zero behavior. Database activity consumes existing
compute/storage allowances. No OCI calls occurred.

After the recorded empty/released inspection, the owner removed the disposable
proof schema. No state records, SQL functions or ownership rows from this proof
remain deployed. Mutation testing removed the generation comparison locally; the
suite failed on the wrong-generation rejection, then passed with it restored.
