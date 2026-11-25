import assert from "node:assert/strict";
import test from "node:test";
import { historyApi } from "../src/application/history/api.ts";
import type { HistoryRead } from "../src/application/history/contract.ts";
import { historyRecord } from "./fixtures/history-record.ts";

const token = "h".repeat(40),
  id = historyRecord.operation;

test("history API authenticates before reads, admits strict bounded pages and expired detail, and redacts failures", async () => {
  const calls: string[] = [];
  const read: HistoryRead = {
    async list(before, limit) {
      calls.push(JSON.stringify(["list", before, limit]));
      if (before === id) throw Error("private-sql-error");
      return { items: [], next: null };
    },
    async detail(operation) {
      calls.push(JSON.stringify(["detail", operation]));
      return operation === id ? historyRecord : null;
    },
  };
  const api = historyApi(token, read);
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
  assert.deepEqual(calls, [JSON.stringify(["list", null, 2])]);
  const detail = await api.fetch(request(`/api/history/${id}`));
  assert.equal(detail.status, 200);
  assert.equal(detail.headers.get("cache-control"), "no-store");
  assert.deepEqual(await detail.json(), historyRecord);
  const missingId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const missing = await api.fetch(request(`/api/history/${missingId}`));
  assert.equal(missing.status, 404);
  assert.equal(await missing.json(), null);
  assert.deepEqual(calls, [
    JSON.stringify(["list", null, 2]),
    JSON.stringify(["detail", id]),
    JSON.stringify(["detail", missingId]),
  ]);
  const failed = await api.fetch(request(`/api/history?before=${id}`));
  assert.equal(failed.status, 503);
  assert.deepEqual(await failed.json(), { error: "history-unavailable" });

  const mismatched = historyApi(token, {
    list: read.list,
    async detail() {
      return historyRecord;
    },
  });
  const wrongRecord = await mismatched.fetch(
    request(`/api/history/${missingId}`),
  );
  assert.equal(wrongRecord.status, 503);
  assert.deepEqual(await wrongRecord.json(), { error: "history-unavailable" });
});

test("history reader checks identity in a read-only transaction, closes on error and rejects provider credentials", async () => {
  const { historyReader } = await import(
    "../src/application/history/runtime.ts"
  );
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
    async query(text, values) {
      queries.push(text);
      if (text === "SELECT berth_executor.history_detail($1) AS result") {
        assert.deepEqual(values, [id]);
        return { rows: [{ result: historyRecord }] };
      }
      return {
        rows: [
          text.includes("AS restricted")
            ? { restricted: true }
            : { result: { items: [], next: null } },
        ],
      };
    },
  }));
  assert.deepEqual(await read.list(null, 20), { items: [], next: null });
  assert.equal(queries[0], "BEGIN READ ONLY");
  assert.ok(queries[1]?.includes("AS restricted"));
  assert.equal(
    queries[2],
    "SELECT berth_executor.history_page($1,$2) AS result",
  );
  assert.equal(closed, 1);
  assert.deepEqual(await read.detail(id), historyRecord);
  assert.deepEqual(queries.slice(3), [
    "BEGIN READ ONLY",
    queries[1],
    "SELECT berth_executor.history_detail($1) AS result",
  ]);
  assert.equal(closed, 2);
  const reject = historyReader(env, () => ({
    async connect() {},
    async end() {
      closed++;
    },
    async query() {
      throw Error("private");
    },
  }));
  await assert.rejects(reject.list(null, 20));
  assert.equal(closed, 3);
  await assert.rejects(
    historyReader({ ...env, OCI_PRIVATE_KEY: "never-read" }).list(null, 20),
  );
});
