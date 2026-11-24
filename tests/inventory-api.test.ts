import assert from "node:assert/strict";
import test from "node:test";
import { inventoryApi } from "../src/application/inventory/api.ts";
import type { InventoryPage } from "../src/application/inventory/contract.ts";
import { inventoryReader } from "../src/application/retained-trial-ledger/inventory.ts";

const token = "i".repeat(40);
const cursor = "10000000-0000-4000-8000-000000000001";
const empty = {
  offering: "oci-object-storage-bucket",
  coverage: "complete",
  items: [],
  next: null,
} satisfies InventoryPage;

test("inventory authenticates and bounds reads before dispatch and preserves coverage", async () => {
  const calls: unknown[][] = [];
  const api = inventoryApi(token, {
    async page(after, limit) {
      calls.push([after, limit]);
      return after ? { ...empty, coverage: "incomplete" } : empty;
    },
  });
  const read = (
    path: string,
    authorization = `Bearer ${token}`,
    method = "GET",
  ) =>
    api.fetch(
      new Request(`https://berth.invalid${path}`, {
        method,
        headers: { authorization },
      }),
    );
  assert.equal((await read("/api/inventory", "Bearer wrong")).status, 401);
  assert.equal((await read("/api/inventory", undefined, "POST")).status, 405);
  assert.equal((await read("/api/history")).status, 404);
  for (const query of [
    "after=bad",
    "limit=51",
    "limit=0",
    "limit=01",
    "limit=1&limit=2",
    "before=x",
  ]) {
    assert.equal((await read(`/api/inventory?${query}`)).status, 400, query);
  }
  assert.deepEqual(calls, []);
  const first = await read("/api/inventory");
  assert.equal(first.headers.get("cache-control"), "no-store");
  assert.deepEqual(await first.json(), empty);
  const older = await read(`/api/inventory?after=${cursor}&limit=50`);
  assert.deepEqual(await older.json(), { ...empty, coverage: "incomplete" });
  assert.deepEqual(calls, [
    [null, 20],
    [cursor, 50],
  ]);
});

test("inventory opens a bounded read-only session and closes it even when the role check fails", async () => {
  const env = {
    BERTH_INVENTORY_DATABASE_URL:
      "postgresql://berth_inventory_runtime:fixture@ep-fixture.aws.neon.tech/neondb?sslmode=require",
  };
  for (const restricted of [true, false]) {
    const calls: string[] = [];
    const reader = inventoryReader(env, (config) => {
      assert.equal(config.user, "berth_inventory_runtime");
      assert.deepEqual(config.ssl, { rejectUnauthorized: true });
      assert.ok(config.statement_timeout);
      return {
        async connect() {
          calls.push("connect");
        },
        async query(text, values) {
          if (
            text === "BEGIN READ ONLY" ||
            text === "SET LOCAL ROLE berth_inventory_reader"
          ) {
            calls.push(text);
            return { rows: [] };
          }
          if (text.includes("session_user")) {
            calls.push("role check");
            return { rows: [{ restricted }] };
          }
          calls.push("projection");
          assert.match(
            text,
            /^SELECT berth_inventory\.inventory_page\(\$1,\$2\)/,
          );
          assert.deepEqual(values, [cursor, 5]);
          return { rows: [{ result: empty }] };
        },
        async end() {
          calls.push("end");
        },
      };
    });
    if (restricted) {
      assert.deepEqual(await reader.page(cursor, 5), empty);
      assert.deepEqual(calls, [
        "connect",
        "BEGIN READ ONLY",
        "role check",
        "SET LOCAL ROLE berth_inventory_reader",
        "projection",
        "end",
      ]);
    } else {
      await assert.rejects(reader.page(cursor, 5));
      assert.deepEqual(calls, [
        "connect",
        "BEGIN READ ONLY",
        "role check",
        "end",
      ]);
    }
  }
  for (const binding of ["DATABASE_URL", "DATABASE_URL_UNPOOLED"]) {
    const reader = inventoryReader(
      { ...env, [binding]: "unexpected injected URL" },
      () => assert.fail("Unexpected database connection"),
    );
    await assert.rejects(reader.page(), /Inventory database unavailable/);
  }
});

test("inventory reports database failure as unavailable with no database diagnostic", async () => {
  const api = inventoryApi(token, {
    async page() {
      throw Error("fixture private database error");
    },
  });
  const response = await api.fetch(
    new Request("https://berth.invalid/api/inventory", {
      headers: { authorization: `Bearer ${token}` },
    }),
  );
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "inventory-unavailable" });
});
