import assert from "node:assert/strict";
import test from "node:test";
import { historyApi } from "../src/application/history/api.ts";
import { inventoryApi } from "../src/application/inventory/api.ts";
import { onRequest as history } from "../ui/functions/api/history/index.ts";
import { onRequest as inventory } from "../ui/functions/api/inventory/index.ts";

const site = "https://berth.example";
const historyOrigin = "https://history.compute.aws.neon.tech";
const inventoryOrigin = "https://inventory.compute.aws.neon.tech";
const browser = "b".repeat(40);
const bindings = {
  BERTH_HISTORY_SITE_ORIGIN: site,
  BERTH_HISTORY_ACCESS_TOKEN: browser,
  BERTH_HISTORY_NEON_ORIGIN: historyOrigin,
  BERTH_HISTORY_UPSTREAM_TOKEN: "h".repeat(40),
  BERTH_INVENTORY_NEON_ORIGIN: inventoryOrigin,
  BERTH_INVENTORY_UPSTREAM_TOKEN: "i".repeat(40),
};

/** Model bearer and origin checks without sending traffic to a hosting provider. */
function request(url: string, token: string, origin?: string) {
  const headers = new Headers();
  if (token) headers.set("authorization", `Bearer ${token}`);
  if (origin) headers.set("origin", origin);
  return new Request(url, { headers });
}

test("read-only access can be shut down and restored without discarding retained evidence", async () => {
  const historyPage = { items: [{ verdict: "partial" }], next: null };
  const inventoryPage = {
    offering: "oci-object-storage-bucket",
    coverage: "incomplete",
    items: [],
    next: null,
  } as const;
  let reads = 0;
  for (const surface of [
    {
      kind: "history",
      proxy: history,
      origin: historyOrigin,
      serviceBinding: "BERTH_HISTORY_UPSTREAM_TOKEN",
      renewedService: "x".repeat(40),
      otherToken: bindings.BERTH_INVENTORY_UPSTREAM_TOKEN,
      page: historyPage,
      api: (token: string) =>
        historyApi(token, async () => {
          reads++;
          return historyPage;
        }),
    },
    {
      kind: "inventory",
      proxy: inventory,
      origin: inventoryOrigin,
      serviceBinding: "BERTH_INVENTORY_UPSTREAM_TOKEN",
      renewedService: "y".repeat(40),
      otherToken: bindings.BERTH_HISTORY_UPSTREAM_TOKEN,
      page: inventoryPage,
      api: (token: string) =>
        inventoryApi(token, {
          async page() {
            reads++;
            return { ...inventoryPage, items: [] };
          },
        }),
    },
  ] as const) {
    const path = `/api/${surface.kind}`;
    const direct = surface.origin + path;
    const published = site + path;
    const before = reads;
    const activeToken = bindings[surface.serviceBinding];
    let api = surface.api(activeToken);
    const upstream: typeof fetch = (input, init) => {
      const forwarded = new Request(input, init);
      assert.equal(forwarded.url, direct);
      return api.fetch(forwarded);
    };
    const read = (origin = site) =>
      surface.proxy(
        { request: request(published, browser, origin), env: bindings },
        upstream,
      );

    for (const denied of ["", browser, surface.otherToken]) {
      assert.equal((await api.fetch(request(direct, denied))).status, 401);
    }

    assert.equal((await read("https://another.example")).status, 403);
    assert.equal(reads, before);
    const first = await read();
    assert.equal(first.status, 200);
    assert.equal(first.headers.get("cache-control"), "no-store");
    assert.deepEqual(await first.json(), surface.page);
    assert.equal(reads, before + 1);

    // Simulate revocation at the upstream even if a prior Pages build still
    // sends the original service token.
    api = surface.api(surface.renewedService);
    assert.equal((await api.fetch(request(direct, activeToken))).status, 401);
    const stopped = await read();
    assert.equal(stopped.status, 503);
    assert.equal(stopped.headers.get("cache-control"), "no-store");
    assert.deepEqual(await stopped.json(), {
      error: `${surface.kind}-unavailable`,
    });
    assert.equal(reads, before + 1);

    // A known-good build with newly authorized credentials can read the
    // same evidence. No database change participates in access rollback.
    const renewedBrowser = "z".repeat(40);
    const restoredBindings = {
      ...bindings,
      BERTH_HISTORY_ACCESS_TOKEN: renewedBrowser,
      [surface.serviceBinding]: surface.renewedService,
    };
    const readRestored = (token: string) =>
      surface.proxy(
        { request: request(published, token, site), env: restoredBindings },
        upstream,
      );
    assert.equal((await readRestored(browser)).status, 401);
    assert.equal(reads, before + 1);
    const restored = await readRestored(renewedBrowser);
    assert.equal(restored.status, 200);
    assert.deepEqual(await restored.json(), surface.page);
    assert.equal(reads, before + 2);
  }
});
