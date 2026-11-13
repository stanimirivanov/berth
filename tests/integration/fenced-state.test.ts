import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as Effect from "effect/Effect";
import { Client } from "pg";
import { claimState, makeFencedState } from "../../src/trial/fenced-state.js";
import { lifecycle } from "./fenced-lifecycle.js";

test("fenced state rejects stale generations and preserves state through takeover", {
  timeout: 30000,
}, async () => {
  const port = Number(process.env.BERTH_TEST_POSTGRES_PORT);
  assert.ok(Number.isInteger(port) && port > 0 && port < 65536);
  const config = {
    host: "127.0.0.1",
    port,
    database: "neondb",
    connectionTimeoutMillis: 3000,
    statement_timeout: 3000,
  };
  const owner = new Client({
    ...config,
    user: "neondb_owner",
    password: "berth-test-only",
  });
  const a = new Client({
    ...config,
    user: "berth_runtime",
    password: "test-runtime-only",
  });
  const b = new Client({
    ...config,
    user: "berth_runtime",
    password: "test-runtime-only",
  });
  let installed = false;
  try {
    await owner.connect();
    await a.connect();
    await b.connect();
    await owner.query(await readFile("sql/fenced-state.sql", "utf8"));
    installed = true;
    const first = await claimState(a, randomUUID(), 30);
    const old = makeFencedState(a, first);
    const req = {
      stack: "berth-fenced-trial",
      stage: "probe",
      fqn: "synthetic",
    };
    const value = {
      resourceType: "Berth.FencedProbe",
      namespace: undefined,
      fqn: "synthetic",
      logicalId: "synthetic",
      instanceId: "fixture",
      providerVersion: 1,
      status: "created" as const,
      downstream: [],
      bindings: [],
      props: { marker: "first" },
      attr: { marker: "first" },
    };
    await Effect.runPromise(old.state.set({ ...req, value }));
    await assert.rejects(claimState(b, randomUUID(), 30), /unavailable/);
    await owner.query(
      "UPDATE berth_state.ownership SET expires_at=clock_timestamp()-interval '1 second'",
    );
    const second = await claimState(b, randomUUID(), 30);
    const fresh = makeFencedState(b, second);
    assert.ok(BigInt(second.generation) > BigInt(first.generation));
    assert.ok(await Effect.runPromise(fresh.state.get(req)));
    await Effect.runPromise(
      fresh.state.set({
        ...req,
        value: {
          ...value,
          props: { marker: "second" },
          attr: { marker: "second" },
        },
      }),
    );
    await assert.rejects(
      Effect.runPromise(old.state.set({ ...req, value })),
      /rejected/,
    );
    await assert.rejects(
      Effect.runPromise(old.state.deleteStack(req)),
      /rejected/,
    );
    await assert.rejects(Effect.runPromise(old.renew()), /rejected/);
    await assert.rejects(Effect.runPromise(old.state.get(req)), /rejected/);
    await assert.rejects(claimState(a, first.owner, 30), /unavailable/);
    const persisted = await owner.query(
      "SELECT value FROM berth_state.records WHERE key=$1",
      ["synthetic"],
    );
    assert.equal(persisted.rows[0].value.attr.marker, "second");
    await assert.rejects(
      Effect.runPromise(
        makeFencedState(b, {
          owner: second.owner,
          generation: first.generation,
        }).state.get(req),
      ),
      /rejected/,
    );
    await assert.rejects(
      a.query("SELECT * FROM berth_state.records"),
      /permission denied/,
    );
    await assert.rejects(
      a.query("SELECT berth_state.valid_fragment('{}'::jsonb)"),
      /permission denied/,
    );
    const functions = await owner.query(
      "SELECT p.prosecdef, p.proconfig FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='berth_state' AND p.proname IN ('claim','access')",
    );
    assert.equal(functions.rows.length, 2);
    for (const fn of functions.rows) {
      assert.equal(fn.prosecdef, true);
      assert.ok(fn.proconfig.includes("search_path=pg_catalog, pg_temp"));
    }

    await assert.rejects(
      a.query("UPDATE berth_state.ownership SET generation=100"),
      /permission denied/,
    );
    await assert.rejects(
      a.query("DELETE FROM berth_state.records"),
      /permission denied/,
    );
    await assert.rejects(
      a.query("CREATE TABLE berth_state.bypass(id int)"),
      /permission denied/,
    );
    await assert.rejects(
      b.query("SELECT berth_state.access($1,$2,'set','synthetic',$3::jsonb)", [
        second.owner,
        second.generation,
        JSON.stringify({ ...value, props: { password: "canary-secret" } }),
      ]),
      /payload/,
    );
    await Effect.runPromise(fresh.state.deleteStack(req));
    await Effect.runPromise(fresh.release());
    assert.equal(
      (await owner.query("SELECT generation FROM berth_state.ownership"))
        .rows[0].generation,
      second.generation,
    );

    const candidates = await Promise.allSettled([
      claimState(a, randomUUID()),
      claimState(b, randomUUID()),
    ]);
    assert.equal(candidates.filter((x) => x.status === "fulfilled").length, 1);
    const winner = candidates.find((x) => x.status === "fulfilled");
    assert.ok(winner?.status === "fulfilled");
    await Effect.runPromise(makeFencedState(a, winner.value).release());
    const uncertainId = randomUUID();
    await assert.rejects(
      claimState(
        {
          query: async (text, values) => {
            await a.query(text, values);
            throw Error("lost response");
          },
        },
        uncertainId,
      ),
    );
    const observed = await claimState(a, uncertainId);
    const expiration = (
      await owner.query("SELECT expires_at FROM berth_state.ownership")
    ).rows[0].expires_at;
    assert.deepEqual(await claimState(b, uncertainId), observed);
    assert.deepEqual(
      (await owner.query("SELECT expires_at FROM berth_state.ownership"))
        .rows[0].expires_at,
      expiration,
    );
    const lost = makeFencedState(
      {
        query: async (text, values) => {
          await a.query(text, values);
          throw Error("lost commit response");
        },
      },
      observed,
    );
    await assert.rejects(
      Effect.runPromise(lost.state.set({ ...req, value })),
      /uncertain/,
    );
    assert.ok(
      await Effect.runPromise(makeFencedState(b, observed).state.get(req)),
    );
    await Effect.runPromise(makeFencedState(a, observed).release());
    const doomed = new Client({
      ...config,
      user: "berth_runtime",
      password: "test-runtime-only",
    });
    const admin = new Client({
      ...config,
      user: "postgres",
      password: "berth-test-only",
    });
    doomed.on("error", () => {});
    try {
      await doomed.connect();
      await admin.connect();
      const short = await claimState(doomed, randomUUID(), 1);
      const pid = (await doomed.query("SELECT pg_backend_pid() AS pid")).rows[0]
        .pid;
      await doomed.query("BEGIN");
      await Effect.runPromise(
        makeFencedState(doomed, short).state.set({
          ...req,
          value: { ...value, attr: { marker: "second" } },
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 1100));
      let settled = false;
      const takeover = claimState(b, randomUUID()).finally(() => {
        settled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(settled, false);
      await admin.query("SELECT pg_terminate_backend($1)", [pid]);
      const recovered = makeFencedState(b, await takeover);
      const afterRollback = await Effect.runPromise(recovered.state.get(req));
      assert.ok(afterRollback && "attr" in afterRollback);
      assert.deepEqual(afterRollback.attr, { marker: "first" });
      await assert.rejects(
        Effect.runPromise(makeFencedState(a, short).state.delete(req)),
        /rejected/,
      );
      await Effect.runPromise(recovered.state.deleteStack(req));
      await lifecycle(recovered.state, "first");
      await lifecycle(recovered.state, "second");
      await lifecycle(recovered.state, "destroy");
      assert.deepEqual(await Effect.runPromise(recovered.state.list(req)), []);
      await Effect.runPromise(recovered.release());
    } finally {
      await doomed.end();
      await admin.end();
    }
  } finally {
    await a.end();
    await b.end();
    if (installed) await owner.query("DROP SCHEMA berth_state CASCADE");
    await owner.end();
  }
});
