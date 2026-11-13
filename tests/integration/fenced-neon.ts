import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as Effect from "effect/Effect";
import { Client } from "pg";
import { readPrivateText } from "../../scripts/oci-files.js";
import { claimState, makeFencedState } from "../../src/trial/fenced-state.js";
import { lifecycle } from "./fenced-lifecycle.js";

// Explicit operator-only live proof; never part of automatic tests or CI.
let db: Client | undefined;
try {
  const mode = process.argv[2];
  assert.ok(["first", "second", "fence", "destroy"].includes(mode ?? ""));
  const config = JSON.parse(await readPrivateText(process.argv[3] ?? ""));
  const uri = new URL(config.DATABASE_URL_UNPOOLED);
  assert.equal(uri.protocol, "postgresql:");
  assert.equal(uri.username, "berth_runtime");
  assert.equal(uri.pathname, "/neondb");
  assert.ok(uri.hostname.endsWith(".neon.tech"));
  uri.searchParams.set("sslmode", "verify-full");
  db = new Client({
    connectionString: uri.href,
    connectionTimeoutMillis: 10000,
    statement_timeout: 5000,
  });
  await db.connect();
  const claim = await claimState(db, randomUUID(), mode === "fence" ? 1 : 30);
  const adapter = makeFencedState(db, claim);
  const req = { stack: "berth-fenced-trial", stage: "probe", fqn: "synthetic" };
  if (mode === "fence") {
    const before = await Effect.runPromise(adapter.state.get(req));
    assert.ok(before);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const fresh = makeFencedState(db, await claimState(db, randomUUID()));
    await assert.rejects(
      Effect.runPromise(adapter.state.set({ ...req, value: before })),
      /rejected/,
    );
    await assert.rejects(
      Effect.runPromise(adapter.state.deleteStack(req)),
      /rejected/,
    );
    await assert.rejects(Effect.runPromise(adapter.renew()), /rejected/);
    assert.deepEqual(await Effect.runPromise(fresh.state.get(req)), before);
    await Effect.runPromise(fresh.release());
  } else {
    if (mode !== "first")
      assert.ok(await Effect.runPromise(adapter.state.get(req)));
    await lifecycle(adapter.state, mode as "first" | "second" | "destroy");
    if (mode === "destroy")
      assert.deepEqual(await Effect.runPromise(adapter.state.list(req)), []);
    else {
      const state = await Effect.runPromise(adapter.state.get(req));
      assert.ok(state && "attr" in state);
      assert.deepEqual(state.attr, { marker: mode });
    }
    await Effect.runPromise(adapter.release());
  }
  console.log(
    JSON.stringify({ mode, result: "passed", generation: claim.generation }),
  );
} catch {
  console.error(
    "Live fenced-state proof failed; preserve schema and reconcile. Provider details withheld.",
  );
  process.exitCode = 1;
} finally {
  if (db) await db.end();
}
