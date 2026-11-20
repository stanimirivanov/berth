import assert from "node:assert/strict";
import test from "node:test";
import { executorStore } from "../src/trial/executor-store.js";

test("operation history uses only parameterized read functions and redacts database failures", async () => {
  const queries: { text: string; values: unknown[] | undefined }[] = [];
  const page = { items: [], next: null };
  const store = executorStore({
    async query(text, values) {
      queries.push({ text, values });
      return {
        rows: [{ result: text.includes("history_page") ? page : null }],
      };
    },
  });
  assert.deepEqual(await store.history(), page);
  assert.equal(await store.historyDetail("fixture-operation"), null);
  await store.history("fixture-cursor", 3);
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
      text: "SELECT berth_executor.history_page($1,$2) AS result",
      values: ["fixture-cursor", 3],
    },
  ]);
  const rejected = executorStore({
    async query() {
      throw Error("private-db-detail");
    },
  });
  await assert.rejects(
    rejected.history(),
    /^Error: Executor state unavailable; reconcile without retry$/,
  );
  await assert.rejects(
    rejected.historyDetail("fixture-operation"),
    /^Error: Executor state unavailable; reconcile without retry$/,
  );
});
