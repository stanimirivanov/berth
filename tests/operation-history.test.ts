import assert from "node:assert/strict";
import test from "node:test";
import { retainedHistoryLedger } from "../src/application/retained-trial-ledger/history.ts";
import { historyRecord } from "./fixtures/history-record.ts";

test("operation history uses only parameterized read functions and redacts database failures", async () => {
  const queries: { text: string; values: unknown[] | undefined }[] = [];
  const page = { items: [], next: null };
  const store = retainedHistoryLedger({
    async query(text, values) {
      queries.push({ text, values });
      return {
        rows: [
          {
            result: text.includes("history_page")
              ? { ...page, privateState: "fixture" }
              : values?.[0] === historyRecord.operation
                ? { ...historyRecord, privateState: "fixture" }
                : null,
          },
        ],
      };
    },
  });
  assert.deepEqual(await store.list(), page);
  assert.equal(await store.detail("fixture-operation"), null);
  assert.deepEqual(await store.detail(historyRecord.operation), historyRecord);
  await store.list("fixture-cursor", 3);
  assert.deepEqual(queries, [
    {
      text: "SELECT berth_executor.history_page($1,$2) AS result",
      values: [null, 20],
    },
    {
      text: "SELECT berth_executor.history_detail($1) AS result",
      values: ["fixture-operation"],
    },
    {
      text: "SELECT berth_executor.history_detail($1) AS result",
      values: [historyRecord.operation],
    },
    {
      text: "SELECT berth_executor.history_page($1,$2) AS result",
      values: ["fixture-cursor", 3],
    },
  ]);
  const rejected = retainedHistoryLedger({
    async query() {
      throw Error("private-db-detail");
    },
  });
  await assert.rejects(
    rejected.list(),
    /^Error: Executor state unavailable; reconcile without retry$/,
  );
  await assert.rejects(
    rejected.detail("fixture-operation"),
    /^Error: Executor state unavailable; reconcile without retry$/,
  );
});
