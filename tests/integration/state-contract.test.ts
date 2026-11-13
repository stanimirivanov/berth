import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout } from "node:timers/promises";
import { makePostgresState } from "@alchemy.run/sql/PostgresState";
import * as PgClient from "@effect/sql-pg/PgClient";
import type { ResourceState } from "alchemy/State/ResourceState";
import { isResourceState, type PersistedState } from "alchemy/State/State";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Redacted from "effect/Redacted";
import * as Reactivity from "effect/reactivity/Reactivity";
import * as Scope from "effect/Scope";
import { Client } from "pg";

/** Synthetic state contains no cloud identity, credential or operation ledger data. */
function resource(marker: string): ResourceState {
  return {
    resourceType: "Berth.StateProbe",
    namespace: undefined,
    fqn: "probe",
    logicalId: "probe",
    instanceId: "synthetic-instance",
    providerVersion: 1,
    status: "created",
    downstream: [],
    bindings: [],
    props: { marker },
    attr: { marker },
  };
}

/** Narrow the actual state union before checking synthetic resource attributes. */
function attributes(value: PersistedState | undefined) {
  assert.ok(isResourceState(value));
  return value.attr;
}

// Explicit opt-in: a disposable loopback database, never a URL or private config.
// Passing means the pinned candidate's limitations are reproduced, NOT approved.
test("native Postgres state qualification under the trial permission boundary", {
  timeout: 30000,
}, async (t) => {
  const port = Number(process.env.BERTH_TEST_POSTGRES_PORT);
  assert.ok(
    Number.isInteger(port) && port > 0 && port < 65536,
    "Set BERTH_TEST_POSTGRES_PORT to the disposable loopback database port",
  );
  const admin = new Client({
    host: "127.0.0.1",
    port,
    database: "neondb",
    user: "postgres",
    password: "berth-test-only",
    connectionTimeoutMillis: 5000,
    statement_timeout: 5000,
  });
  const scopes: Scope.Closeable[] = [];
  let roleOwned = false;
  let schemaOwned = false;
  const request = { stack: "qualification", stage: "local", fqn: "probe" };
  /** Each store owns a separate pool and lease; all scopes close before fixture teardown. */
  async function open() {
    const scope = await Effect.runPromise(Scope.make());
    scopes.push(scope);
    const sql = await Effect.runPromise(
      PgClient.make({
        host: "127.0.0.1",
        port,
        database: "neondb",
        username: "state_trial_runtime",
        password: Redacted.make("state-test-only"),
        maxConnections: 4,
        connectTimeout: "5 seconds",
        startupParameters: {
          search_path: "state_trial",
          statement_timeout: "5000",
        },
      }).pipe(Scope.provide(scope), Effect.provide(Reactivity.layer)),
    );
    const state = await Effect.runPromise(
      makePostgresState({ client: sql, leaseCheckTtlMs: 0 }, scope),
    );
    return {
      state,
      close: () => Effect.runPromise(Scope.close(scope, Exit.void)),
    };
  }
  try {
    await admin.connect();
    // Refuse to adopt an existing fixture. No IF NOT EXISTS on creation.
    await admin.query(
      "CREATE ROLE state_trial_runtime LOGIN PASSWORD 'state-test-only'",
    );
    roleOwned = true;
    await admin.query("CREATE SCHEMA state_trial");
    schemaOwned = true;
    await admin.query(
      "REVOKE ALL ON SCHEMA state_trial FROM PUBLIC; GRANT USAGE ON SCHEMA state_trial TO state_trial_runtime",
    );
    await admin.query(
      `CREATE TABLE state_trial.alchemy_resource_state (stack text NOT NULL, stage text NOT NULL, fqn text NOT NULL, value jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(stack, stage, fqn)); CREATE TABLE state_trial.alchemy_stack_output (stack text NOT NULL, stage text NOT NULL, value jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(stack, stage)); GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA state_trial TO state_trial_runtime`,
    );
    await t.test(
      "prebootstrapped owner-held tables still require runtime schema CREATE",
      async () => {
        const candidate = await open();
        await assert.rejects(
          Effect.runPromise(candidate.state.listStacks()),
          (error: unknown) => {
            assert.ok(
              error !== null && typeof error === "object" && "cause" in error,
            );
            assert.match(JSON.stringify(error), /42501/);
            return true;
          },
        );
        const grants = await admin.query(
          "SELECT has_schema_privilege('state_trial_runtime', 'state_trial', 'CREATE') AS ddl, has_table_privilege('state_trial_runtime', 'state_trial.alchemy_resource_state', 'SELECT,INSERT,UPDATE,DELETE') AS crud",
        );
        assert.deepEqual(grants.rows, [{ ddl: false, crud: true }]);
        await candidate.close();
      },
    );
    // LOCAL CONTROL ONLY. This is deliberately outside Berth's approved runtime
    // grants, to isolate the store's other properties; never deploy this grant.
    await admin.query(
      "GRANT CREATE ON SCHEMA state_trial TO state_trial_runtime",
    );
    await t.test(
      "independent pools retain CRUD state and reject ordinary concurrent owners",
      async () => {
        const first = await open();
        await Effect.runPromise(
          first.state.set({ ...request, value: resource("first") }),
        );
        const contender = await open();
        await assert.rejects(
          Effect.runPromise(contender.state.get(request)),
          /another deploy holds/,
        );
        await contender.close();
        await first.close();
        const second = await open();
        assert.deepEqual(
          attributes(await Effect.runPromise(second.state.get(request))),
          { marker: "first" },
        );
        await Effect.runPromise(
          second.state.set({ ...request, value: resource("second") }),
        );
        await admin.query(
          "ALTER TABLE state_trial.alchemy_resource_state ADD CONSTRAINT reject_fault CHECK (value->'props'->>'marker' <> 'fault')",
        );
        await assert.rejects(
          Effect.runPromise(
            second.state.set({ ...request, value: resource("fault") }),
          ),
        );
        assert.deepEqual(
          attributes(await Effect.runPromise(second.state.get(request))),
          { marker: "second" },
        );
        await Effect.runPromise(second.state.delete(request));
        assert.equal(
          await Effect.runPromise(second.state.get(request)),
          undefined,
        );
        await second.close();
      },
    );
    await t.test(
      "Redacted values are plaintext in persisted state, not encrypted secrets",
      async () => {
        const candidate = await open();
        const canary = "synthetic-secret-canary-not-a-credential";
        const value = {
          ...resource("canary"),
          props: { token: Redacted.make(canary) },
        };
        await Effect.runPromise(candidate.state.set({ ...request, value }));
        const rows = await admin.query(
          "SELECT value::text AS payload FROM state_trial.alchemy_resource_state",
        );
        assert.equal(rows.rows.length, 1);
        assert.ok(rows.rows[0].payload.includes(canary));
        await Effect.runPromise(candidate.state.delete(request));
        await candidate.close();
      },
    );
    await t.test(
      "lost lease after validation permits an in-flight stale write to overwrite a new owner",
      async () => {
        await admin.query(
          `CREATE FUNCTION state_trial.pause_stale() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.value->'props'->>'marker' = 'stale' THEN PERFORM pg_advisory_xact_lock(77331); END IF; RETURN NEW; END $$; CREATE TRIGGER pause_stale BEFORE INSERT ON state_trial.alchemy_resource_state FOR EACH ROW EXECUTE FUNCTION state_trial.pause_stale()`,
        );
        const first = await open();
        await Effect.runPromise(
          first.state.set({ ...request, value: resource("initial") }),
        );
        const holder = await admin.query(
          "SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND granted AND objsubid = 1 AND ((classid::bigint << 32) | (objid::bigint & 4294967295)) = hashtextextended('alchemy:qualification/local', 0)",
        );
        assert.equal(holder.rows.length, 1);
        await admin.query("SELECT pg_advisory_lock(77331)");
        // Attach handlers immediately so a timeout cannot become an unhandled rejection.
        const pending = Effect.runPromise(
          first.state.set({ ...request, value: resource("stale") }),
        ).then(
          () => "committed",
          () => "rejected",
        );
        try {
          let waiting = false;
          for (let attempt = 0; attempt < 100; attempt++) {
            const blocked = await admin.query(
              "SELECT 1 FROM pg_locks WHERE locktype='advisory' AND objid=77331 AND NOT granted",
            );
            if (blocked.rowCount === 1) {
              waiting = true;
              break;
            }
            await setTimeout(20);
          }
          assert.ok(
            waiting,
            "Stale writer must be paused after lease validation",
          );
          await admin.query("SELECT pg_terminate_backend($1)", [
            holder.rows[0].pid,
          ]);
          const second = await open();
          await Effect.runPromise(
            second.state.set({ ...request, value: resource("new-owner") }),
          );
          await admin.query("SELECT pg_advisory_unlock(77331)");
          assert.equal(await pending, "committed");
          assert.deepEqual(
            attributes(await Effect.runPromise(second.state.get(request))),
            { marker: "stale" },
          );
          await assert.rejects(
            Effect.runPromise(first.state.get(request)),
            /lost mid-run/,
          );
          await second.close();
        } finally {
          await admin.query("SELECT pg_advisory_unlock(77331)");
          await pending;
          await first.close();
        }
      },
    );
  } finally {
    for (const scope of scopes.reverse())
      await Effect.runPromise(Scope.close(scope, Exit.void));
    if (schemaOwned) await admin.query("DROP SCHEMA state_trial CASCADE");
    if (roleOwned) await admin.query("DROP ROLE state_trial_runtime");
    await admin.end();
  }
});
