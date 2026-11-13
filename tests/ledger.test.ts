import assert from "node:assert/strict";
import test from "node:test";
import { makeLedger } from "../src/trial/ledger.js";

test("ledger does not retry unknown SQL outcomes or expose provider error details", async () => {
  let calls = 0;
  const ledger = makeLedger({
    query: async () => {
      calls++;
      throw Error("private-provider-canary");
    },
  });
  await assert.rejects(
    ledger.reserve(
      { operation: "fixture", owner: "fixture", generation: "1" },
      "attempt",
      "request",
    ),
    (error) =>
      String(error).includes("uncertain") && !String(error).includes("canary"),
  );
  assert.equal(calls, 1);
});
test("ledger returns frozen execution claims and duplicate receipts never authorize a new dispatch", async () => {
  const claim = { operation: "fixture", owner: "fixture", generation: "1" };
  const ledger = makeLedger({
    query: async (sql) => ({
      rows: [
        {
          result: sql.includes(".claim(")
            ? claim
            : { id: "request", fresh: false },
        },
      ],
    }),
  });
  assert.ok(Object.isFrozen(await ledger.claim("fixture", "fixture")));
  assert.equal(
    (await ledger.reserve(claim, "attempt", "request")).fresh,
    false,
  );
});
