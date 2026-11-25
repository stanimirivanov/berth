import assert from "node:assert/strict";
import test from "node:test";
import { historyApi } from "../src/application/history/api.ts";
import { onRequest as nestedMiss } from "../ui/functions/api/history/[[rest]].ts";
import { onRequest as detail } from "../ui/functions/api/history/[operation].ts";
import { onRequest as list } from "../ui/functions/api/history/index.ts";
import { historyRecord } from "./fixtures/history-record.ts";

const id = historyRecord.operation;
const env = {
  BERTH_HISTORY_SITE_ORIGIN: "https://berth.pages.dev",
  BERTH_HISTORY_NEON_ORIGIN:
    "https://br-fixture-api.compute.c-2.us-east-2.aws.neon.tech",
  BERTH_HISTORY_ACCESS_TOKEN: "a".repeat(40),
  BERTH_HISTORY_UPSTREAM_TOKEN: "b".repeat(40),
};

function request(path: string, init: RequestInit = {}) {
  return new Request(env.BERTH_HISTORY_SITE_ORIGIN + path, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.BERTH_HISTORY_ACCESS_TOKEN}`,
      ...init.headers,
    },
  });
}

test("Pages list and detail reach the real Neon handler with only server-side authorization", async () => {
  const calls: unknown[][] = [];
  const neon = historyApi(env.BERTH_HISTORY_UPSTREAM_TOKEN, {
    async list(before, limit) {
      calls.push(["list", before, limit]);
      return { items: [], next: null };
    },
    async detail(operation) {
      calls.push(["detail", operation]);
      return { ...historyRecord, operation };
    },
  });
  const upstream: typeof fetch = async (url, init) => {
    const sent = new Request(url, init);
    assert.equal(new URL(sent.url).origin, env.BERTH_HISTORY_NEON_ORIGIN);
    assert.deepEqual([...sent.headers.keys()], ["accept", "authorization"]);
    assert.equal(
      sent.headers.get("authorization"),
      `Bearer ${env.BERTH_HISTORY_UPSTREAM_TOKEN}`,
    );
    assert.equal(init?.redirect, "manual");
    assert.equal(init?.cache, "no-store");
    assert.ok(init?.signal);
    return neon.fetch(sent);
  };
  const page = await list(
    {
      request: request(`/api/history?before=${id}&limit=2`, {
        headers: { cookie: "fixture", "x-forwarded-host": "fixture.invalid" },
      }),
      env,
    },
    upstream,
  );
  assert.deepEqual(await page.json(), { items: [], next: null });
  const record = await detail(
    { request: request(`/api/history/${id}`), env },
    upstream,
  );
  assert.deepEqual(await record.json(), historyRecord);
  assert.equal(record.headers.get("cache-control"), "no-store");
  assert.equal(record.headers.get("access-control-allow-origin"), null);
  assert.deepEqual(calls, [
    ["list", id, 2],
    ["detail", id],
  ]);
});

test("Pages rejects invalid auth, origin, method, paths, query and target configuration before fetch", async () => {
  const cases = [
    [
      request("/api/history", { headers: { Authorization: "Bearer wrong" } }),
      env,
      401,
    ],
    [
      request("/api/history", {
        headers: { origin: "https://foreign.invalid" },
      }),
      env,
      403,
    ],
    [
      request("/api/history", { headers: { "sec-fetch-site": "cross-site" } }),
      env,
      403,
    ],
    [new Request("https://preview.berth.pages.dev/api/history"), env, 403],
    [request("/api/history", { method: "POST" }), env, 405],
    [request("/api/history?limit=51"), env, 400],
    [request("/api/history?limit=1&limit=1"), env, 400],
    [request("/api/history?before=unknown"), env, 400],
    [request("/api/history?target=https://foreign.invalid"), env, 400],
    [request(`/api/history?x=${"a".repeat(300)}`), env, 400],
    [request("/api/history/wrong"), env, 404],
    [request("/scheduled"), env, 404],
    [
      request("/api/history"),
      {
        ...env,
        BERTH_HISTORY_NEON_ORIGIN: "https://neon.tech.foreign.invalid",
      },
      503,
    ],
    [
      request("/api/history"),
      {
        ...env,
        BERTH_HISTORY_NEON_ORIGIN: `${env.BERTH_HISTORY_NEON_ORIGIN}/scheduled`,
      },
      503,
    ],
    [
      request("/api/history"),
      { ...env, BERTH_HISTORY_UPSTREAM_TOKEN: env.BERTH_HISTORY_ACCESS_TOKEN },
      503,
    ],
  ] as const;
  let calls = 0;
  const upstream: typeof fetch = async () => {
    calls++;
    return Response.json({});
  };
  for (const [incoming, bindings, status] of cases)
    assert.equal(
      (await list({ request: incoming, env: bindings }, upstream)).status,
      status,
      incoming.url,
    );
  assert.equal(calls, 0);
});

test("the Pages history catch-all returns a JSON miss without contacting upstream", async () => {
  const response = await nestedMiss(
    { request: request("/api/history/too/deep"), env },
    async () => {
      assert.fail("An unknown history path must not reach Neon");
    },
  );
  assert.equal(response.status, 404);
  assert.match(
    response.headers.get("content-type") ?? "",
    /^application\/json/,
  );
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { error: "not-found" });
});

test("Pages returns fixed errors for redirects, upstream failures, oversized or malformed bodies", async () => {
  let cancelled = false;
  const large = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(128 * 1024 + 1));
    },
    cancel() {
      cancelled = true;
    },
  });
  const responses = [
    new Response(null, {
      status: 302,
      headers: { location: "https://foreign.invalid" },
    }),
    new Response("private upstream error", { status: 401 }),
    new Response("private upstream error", { status: 429 }),
    new Response("private upstream error", { status: 500 }),
    new Response("not JSON", {
      headers: { "content-type": "application/json" },
    }),
    new Response(large, { headers: { "content-type": "application/json" } }),
    new Response("<html>fixture</html>"),
  ];
  for (const upstream of responses) {
    const result = await list(
      { request: request("/api/history"), env },
      async () => upstream,
    );
    assert.equal(result.status, 503);
    assert.deepEqual(await result.json(), { error: "history-unavailable" });
    assert.equal(result.headers.get("location"), null);
  }
  assert.equal(cancelled, true);
  const missing = await detail(
    { request: request(`/api/history/${id}`), env },
    async () => new Response("private 404", { status: 404 }),
  );
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: "not-found" });
});

test("Pages invocation rules isolate only the history API from the static UI", async () => {
  const { readFile } = await import("node:fs/promises");
  const routes = JSON.parse(await readFile("ui/public/_routes.json", "utf8"));
  assert.deepEqual(
    {
      ...routes,
      include: routes.include.filter((route: string) =>
        route.startsWith("/api/history"),
      ),
    },
    {
      version: 1,
      include: ["/api/history", "/api/history/*"],
      exclude: [],
    },
  );
});
