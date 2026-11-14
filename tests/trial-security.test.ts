import assert from "node:assert/strict";
import test from "node:test";
import { assertExecutorPrivileges } from "../src/trial/executor-hosted.js";

test("executor rejects missing, false and uncertain privilege evidence without exposing database details", async () => {
  for (const rows of [[], [{ restricted: false }], [{ restricted: null }]])
    await assert.rejects(
      () => assertExecutorPrivileges({ query: async () => ({ rows }) }),
      /Runtime privilege boundary failed/,
    );
  await assert.rejects(
    () =>
      assertExecutorPrivileges({
        query: async () => {
          throw Error("private-canary");
        },
      }),
    /^Error: Runtime privilege boundary failed$/,
  );
  await assertExecutorPrivileges({
    query: async () => ({ rows: [{ restricted: true }] }),
  });
});

test("hosted startup refuses privilege drift before claiming work or reading reports", async (t) => {
  const { Client } = await import("pg");
  const { execute } = await import("../src/trial/executor-hosted.js");
  let calls = 0,
    closed = 0;
  t.mock.method(Client.prototype, "connect", async () => {});
  t.mock.method(Client.prototype, "end", async () => {
    closed++;
  });
  t.mock.method(Client.prototype, "query", async (sql: string) => {
    calls++;
    assert.match(sql, /pg_auth_members/);
    return { rows: [{ restricted: false }] };
  });
  for (const delivery of [undefined, "a".repeat(64)])
    await assert.rejects(
      () =>
        execute(
          {
            connection: "postgresql://fixture.invalid/neondb",
            operation: "fixture",
            startedAt: 0,
            expiresAt: Date.now() + 60000,
            token: "fixture",
          },
          delivery,
        ),
      /Runtime privilege boundary failed/,
    );
  assert.equal(calls, 2);
  assert.equal(closed, 2);
});
