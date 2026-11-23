import assert from "node:assert/strict";
import test from "node:test";
import { retryApi } from "../src/application/retry/api.ts";

const credential = `berth-retry-owner-v1.${"x".repeat(43)}`;
const operation = "62ebd914-6089-4e41-81a4-75081cb1cef3";
const origin = "https://test.invalid";

test("only a fresh owner action session can start or inspect reconciliation", async () => {
  const calls: string[] = [];
  let now = 1800000000000;
  const api = retryApi(
    credential,
    async (action, id) => {
      calls.push(`${action}:${id}`);
      return {
        operation: id,
        stage: "checking-provider",
        scope: "after-expiry",
        result: null,
        reason: null,
        ownerProcedure: null,
        observedAt: null,
        startedAt: new Date(now).toISOString(),
        checks: { used: 1, limit: 2 },
      };
    },
    () => now,
  );
  const url = `/api/retry/operations/${operation}`;
  const send = (path: string, method: string, token: string, body?: string) =>
    api.fetch(
      new Request(origin + path, {
        method,
        headers: { authorization: `Bearer ${token}` },
        ...(body === undefined ? {} : { body }),
      }),
    );

  assert.equal(
    (await send("/api/retry/session", "POST", "a".repeat(43))).status,
    401,
  );
  assert.equal((await send(url, "POST", credential)).status, 401);
  assert.deepEqual(calls, []);
  const signedIn = await send("/api/retry/session", "POST", credential);
  assert.equal(signedIn.status, 200);
  assert.equal(signedIn.headers.get("cache-control"), "no-store");
  const { session, expiresAt } = await signedIn.json();
  assert.equal(Date.parse(expiresAt) - now, 300000);
  assert.equal((await send(url, "POST", session, "{}")).status, 400);
  assert.equal(
    (await send(`${url}?target=alternate`, "POST", session)).status,
    404,
  );
  assert.equal((await send(url, "POST", session)).status, 202);
  assert.equal((await send(url, "GET", session)).status, 200);
  assert.deepEqual(calls, [`start:${operation}`, `status:${operation}`]);
  now += 300000;
  assert.equal((await send(url, "GET", session)).status, 401);
  assert.equal(calls.length, 2);
});

test("a retry session that expires during empty body inspection cannot start a check", async () => {
  let now = 1800000000000;
  let dispatched = 0;
  const api = retryApi(
    credential,
    async () => {
      dispatched++;
      return null;
    },
    () => now,
  );
  const signed = await api.fetch(
    new Request(`${origin}/api/retry/session`, {
      method: "POST",
      headers: { authorization: `Bearer ${credential}` },
    }),
  );
  const { session } = await signed.json();
  now += 299999;
  const body = new ReadableStream(
    {
      pull(controller) {
        now++;
        controller.close();
      },
    },
    { highWaterMark: 0 },
  );
  const request = new Request(`${origin}/api/retry/operations/${operation}`, {
    method: "POST",
    headers: { authorization: `Bearer ${session}` },
    body,
    duplex: "half",
  } as RequestInit);
  assert.equal((await api.fetch(request)).status, 401);
  assert.equal(dispatched, 0);
});

test("retry responses project only the public status fields", async () => {
  const status = {
    operation,
    stage: "checking-provider",
    scope: "after-expiry",
    result: null,
    reason: null,
    ownerProcedure: null,
    observedAt: null,
    startedAt: "2026-11-23T12:00:00Z",
    checks: { used: 1, limit: 2 },
  } satisfies NonNullable<
    Awaited<ReturnType<import("../src/application/retry/api.ts").RetryAction>>
  >;
  const api = retryApi(credential, async () => ({
    ...status,
    privateProviderId: "fixture-private",
    checks: { ...status.checks, privateCounter: 8 },
  }));
  const signed = await api.fetch(
    new Request(`${origin}/api/retry/session`, {
      method: "POST",
      headers: { authorization: `Bearer ${credential}` },
    }),
  );
  const { session } = await signed.json();
  const result = await api.fetch(
    new Request(`${origin}/api/retry/operations/${operation}`, {
      headers: { authorization: `Bearer ${session}` },
    }),
  );
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), status);
});
