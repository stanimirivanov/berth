import assert from "node:assert/strict";
import test from "node:test";
import { historyApi } from "../src/trial/history-api.js";

const token = "h".repeat(40),
  id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

test("history API authenticates before reads, admits strict bounded pages and expired detail, and redacts failures", async () => {
  const calls: string[] = [];
  const api = historyApi(token, async (operation, before, limit) => {
    calls.push(JSON.stringify([operation, before, limit]));
    if (operation === id)
      return { operation: id, expiresAt: "2020-01-01", verdict: "partial" };
    if (before === id) throw Error("private-sql-error");
    return { items: [], next: null };
  });
  const request = (path: string, auth = token) =>
    new Request(`https://fixture${path}`, {
      headers: { authorization: `Bearer ${auth}` },
    });
  assert.equal((await api.fetch(request("/api/history", "bad"))).status, 401);
  assert.equal(calls.length, 0);
  for (const path of [
    "/api/history?limit=51",
    "/api/history?before=bad",
    "/api/history?limit=2&limit=3",
    "/api/history?target=anything",
    "/api/history/nope",
    `/api/history/${id}?limit=1`,
  ])
    assert.equal((await api.fetch(request(path))).status, 400);
  assert.equal(calls.length, 0);
  assert.equal((await api.fetch(request("/api/history?limit=2"))).status, 200);
  assert.deepEqual(calls, [JSON.stringify([null, null, 2])]);
  const detail = await api.fetch(request(`/api/history/${id}`));
  assert.equal(detail.status, 200);
  assert.equal(detail.headers.get("cache-control"), "no-store");
  assert.equal((await detail.json()).verdict, "partial");
  const failed = await api.fetch(request(`/api/history?before=${id}`));
  assert.equal(failed.status, 503);
  assert.deepEqual(await failed.json(), { error: "history-unavailable" });
});

test("history reader checks identity in a read-only transaction, closes on error and rejects provider credentials", async () => {
  const { historyReader } = await import("../src/trial/history-runtime.js");
  const env = {
    DATABASE_URL:
      "postgresql://berth_runtime:fixture@ep-fixture.neon.tech/neondb",
    DATABASE_URL_UNPOOLED:
      "postgresql://berth_runtime:fixture@ep-fixture.neon.tech/neondb",
  };
  let closed = 0;
  const queries: string[] = [];
  const read = historyReader(env, () => ({
    async connect() {},
    async end() {
      closed++;
    },
    async query(text: string) {
      queries.push(text);
      return {
        rows: [
          text.includes("AS restricted")
            ? { restricted: true }
            : { result: { items: [], next: null } },
        ],
      };
    },
  }));
  assert.deepEqual(await read(null, null, 20), { items: [], next: null });
  assert.equal(queries[0], "BEGIN READ ONLY");
  assert.ok(queries[1]?.includes("AS restricted"));
  assert.equal(
    queries[2],
    "SELECT berth_executor.history_page($1,$2) AS result",
  );
  assert.equal(closed, 1);
  const reject = historyReader(env, () => ({
    async connect() {},
    async end() {
      closed++;
    },
    async query() {
      throw Error("private");
    },
  }));
  await assert.rejects(reject(null, null, 20));
  assert.equal(closed, 2);
  await assert.rejects(
    historyReader({ ...env, OCI_PRIVATE_KEY: "never-read" })(null, null, 20),
  );
});
