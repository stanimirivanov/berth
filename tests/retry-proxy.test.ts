import assert from "node:assert/strict";
import test from "node:test";
import { retryApi } from "../src/application/retry/api.ts";
import { onRequest } from "../ui/functions/api/retry/[[rest]].ts";

const site = "https://berth.example";
const env = {
  BERTH_HISTORY_SITE_ORIGIN: site,
  BERTH_RETRY_NEON_ORIGIN: "https://retry.compute.aws.neon.tech",
};
const credential = `berth-retry-owner-v1.${"o".repeat(43)}`;
const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

test("Pages authorizes the exact Retry route and forwards only the scoped credential to the real handler", async () => {
  const calls: string[] = [];
  const backend = retryApi(
    credential,
    async () => null,
    Date.now,
    async (operation) => {
      calls.push(operation);
      return null;
    },
  );
  let forwarded = 0;
  const upstream: typeof fetch = async (url, init) => {
    forwarded++;
    const request = new Request(url, init);
    assert.equal(new URL(request.url).origin, env.BERTH_RETRY_NEON_ORIGIN);
    assert.deepEqual([...request.headers.keys()], ["accept", "authorization"]);
    return backend.fetch(request);
  };
  const invoke = (
    path: string,
    method: string,
    bearer: string,
    headers: HeadersInit = {},
    body?: string,
  ) =>
    onRequest(
      {
        env,
        request: new Request(site + path, {
          method,
          headers: {
            authorization: `Bearer ${bearer}`,
            cookie: "fixture",
            ...headers,
          },
          ...(body === undefined ? {} : { body }),
        }),
      },
      upstream,
    );
  const status = `/api/retry/operations/${id}/continuation`;
  assert.equal(
    (await invoke("/api/retry/session", "POST", "h".repeat(40))).status,
    401,
  );
  assert.equal(
    (await invoke("/api/retry/session?ignored=1", "POST", credential)).status,
    404,
  );
  assert.equal(
    (
      await invoke("/api/retry/session", "POST", credential, {
        origin: "https://other.example",
      })
    ).status,
    403,
  );
  assert.equal(
    (await invoke("/api/retry/session", "POST", credential, {}, "{}")).status,
    400,
  );
  assert.equal(
    (
      await invoke(
        `/api/retry/operations/${id}/proposals/${id}/approve`,
        "POST",
        "h".repeat(40),
      )
    ).status,
    401,
  );
  assert.equal(forwarded, 0);
  const signed = await onRequest(
    {
      env,
      request: new Request(`${site}/api/retry/session`, {
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${credential}`,
        },
        body: new ReadableStream({
          start(controller) {
            controller.close();
          },
        }),
        duplex: "half",
      } as RequestInit),
    },
    upstream,
  );
  assert.equal(signed.status, 200);
  assert.equal(signed.headers.get("cache-control"), "no-store");
  const { session } = await signed.json();
  assert.equal((await invoke(status, "POST", session)).status, 404);
  assert.equal((await invoke(status, "GET", credential)).status, 401);
  assert.equal((await invoke(status, "GET", session)).status, 404);
  assert.deepEqual(calls, [id]);
  assert.equal(forwarded, 2);
});
