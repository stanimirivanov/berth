import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { inventoryApi } from "../src/application/inventory/api.ts";
import { retainedInventoryLedger } from "../src/application/retained-trial-ledger/inventory.ts";
import { onRequest as inventoryMiss } from "../ui/functions/api/inventory/[[rest]].ts";
import { onRequest } from "../ui/functions/api/inventory/index.ts";

const site = "https://berth.example";
const browserToken = "b".repeat(40);
const serviceToken = "i".repeat(40);
const cursor = "10000000-0000-4000-8000-000000000001";
const env = {
  BERTH_HISTORY_SITE_ORIGIN: site,
  BERTH_HISTORY_ACCESS_TOKEN: browserToken,
  BERTH_HISTORY_UPSTREAM_TOKEN: "h".repeat(40),
  BERTH_INVENTORY_NEON_ORIGIN:
    "https://berthinventory118.compute.aws.neon.tech",
  BERTH_INVENTORY_UPSTREAM_TOKEN: serviceToken,
};

test("Inventory uses shared browser access, separate upstream credentials and an allowlisted page", async () => {
  const requests: string[] = [];
  const at = "2026-01-01T10:00:00Z";
  const item = {
    instance: cursor,
    operation: "20000000-0000-4000-8000-000000000001",
    displayName: "fixture",
    region: "eu-frankfurt-1",
    presence: "uncertain",
    observedAt: at,
    lastVerifiedAt: null,
    uncertainty: "create-unresolved",
  };
  const projected = {
    offering: "oci-object-storage-bucket",
    coverage: "incomplete",
    items: [item],
    next: cursor,
  };
  const neon = inventoryApi(
    serviceToken,
    retainedInventoryLedger({
      async query(sql, parameters) {
        assert.match(sql, /^SELECT berth_inventory\.inventory_page/);
        assert.deepEqual(parameters, [cursor, 1]);
        return {
          rows: [
            {
              result: {
                ...projected,
                items: [{ ...item, privateProviderId: "fixture" }],
              },
            },
          ],
        };
      },
    }),
  );
  const after = `/api/inventory?after=${cursor}&limit=1`;
  const request = new Request(site + after, {
    headers: { authorization: `Bearer ${browserToken}` },
  });
  const response = await onRequest({ request, env }, async (input, init) => {
    const upstream = new Request(input, init);
    requests.push(upstream.url);
    assert.equal(
      upstream.headers.get("authorization"),
      `Bearer ${serviceToken}`,
    );
    assert.equal(init?.redirect, "manual");
    assert.equal(upstream.cache, "no-store");
    assert.ok(init?.signal);
    return neon.fetch(upstream);
  });
  assert.equal(response.status, 200);
  assert.deepEqual(requests, [env.BERTH_INVENTORY_NEON_ORIGIN + after]);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), projected);
});

test("Inventory suppresses denied requests and upstream errors without forwarding private data", async () => {
  const request = (path = "/api/inventory", headers: HeadersInit = {}) =>
    new Request(site + path, {
      headers: { authorization: `Bearer ${browserToken}`, ...headers },
    });
  let calls = 0;
  const upstream = async () => {
    calls++;
    return Response.json({ privateError: "fixture" }, { status: 401 });
  };
  for (const [req, status] of [
    [request(undefined, { origin: "https://wrong.example" }), 403],
    [request(undefined, { authorization: `Bearer ${serviceToken}` }), 401],
    [request("/api/inventory?before=wrong"), 400],
    [request("/api/inventory?limit=51"), 400],
    [request("/api/inventory/extra"), 404],
  ] as const)
    assert.equal(
      (await onRequest({ request: req, env }, upstream)).status,
      status,
    );
  assert.equal(
    (
      await onRequest(
        {
          request: request(),
          env: { ...env, BERTH_INVENTORY_UPSTREAM_TOKEN: browserToken },
        },
        upstream,
      )
    ).status,
    503,
  );
  assert.equal(calls, 0);
  const failure = await onRequest({ request: request(), env }, upstream);
  assert.equal(failure.status, 503);
  assert.deepEqual(await failure.json(), { error: "inventory-unavailable" });
  assert.equal(calls, 1);
  const oversized = await onRequest({ request: request(), env }, async () =>
    Response.json({ payload: "a".repeat(128 * 1024) }),
  );
  assert.equal(oversized.status, 503);
});

test("Pages routes only the two read APIs through Functions and catches nested Inventory misses", async () => {
  assert.deepEqual(
    JSON.parse(await readFile("ui/public/_routes.json", "utf8")),
    {
      version: 1,
      include: [
        "/api/history",
        "/api/history/*",
        "/api/inventory",
        "/api/inventory/*",
      ],
      exclude: [],
    },
  );
  const response = await inventoryMiss(
    {
      request: new Request(`${site}/api/inventory/extra`),
      env,
    },
    async () => assert.fail("unexpected upstream request"),
  );
  assert.equal(response.status, 404);
});

test("Inventory Pages validates successful upstream JSON and removes nonpublic fields", async () => {
  const request = new Request(`${site}/api/inventory`, {
    headers: { authorization: `Bearer ${browserToken}` },
  });
  const page = {
    offering: "oci-object-storage-bucket",
    coverage: "complete",
    items: [],
    next: null,
  };
  const invalid = await onRequest({ request, env }, async () =>
    Response.json({ ...page, items: [{ privateProviderId: "fixture" }] }),
  );
  assert.equal(invalid.status, 503);
  assert.deepEqual(await invalid.json(), { error: "inventory-unavailable" });
  const valid = await onRequest({ request, env }, async () =>
    Response.json({ ...page, privateEvidence: "fixture" }),
  );
  assert.equal(valid.status, 200);
  assert.deepEqual(await valid.json(), page);
});
