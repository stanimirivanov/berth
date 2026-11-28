import assert from "node:assert/strict";
import test from "node:test";
import { onRequest } from "../ui/functions/api/inventory/oci-storage.ts";

const site = "https://berth.example";
const path = "/api/inventory/oci-storage";
const browser = "b".repeat(40);
const service = "s".repeat(40);
const env = {
  BERTH_HISTORY_SITE_ORIGIN: site,
  BERTH_HISTORY_ACCESS_TOKEN: browser,
  BERTH_HISTORY_UPSTREAM_TOKEN: "h".repeat(40),
  BERTH_INVENTORY_UPSTREAM_TOKEN: "i".repeat(40),
  BERTH_OCI_STORAGE_UPSTREAM_TOKEN: service,
  BERTH_OCI_STORAGE_NEON_ORIGIN:
    "https://berthocistorage200.compute.aws.neon.tech",
};
const snapshot = { attemptedAt: null, gap: null, reading: null };

test("the allowance route forwards one protected saved read to its scoped upstream", async () => {
  const result = await onRequest(
    {
      request: new Request(site + path, {
        headers: { authorization: `Bearer ${browser}` },
      }),
      env,
    },
    async (input, init) => {
      assert.equal(String(input), env.BERTH_OCI_STORAGE_NEON_ORIGIN + path);
      assert.equal(
        new Headers(init?.headers).get("authorization"),
        `Bearer ${service}`,
      );
      assert.equal(init?.method, "GET");
      return Response.json({ ...snapshot, internal: "must remain private" });
    },
  );
  assert.equal(result.status, 200);
  assert.equal(result.headers.get("cache-control"), "no-store");
  assert.deepEqual(await result.json(), snapshot);
});

test("the allowance route refuses cross-site, wrong-token, and noncanonical reads before calling the upstream", async () => {
  const check = (url: string, headers: HeadersInit, method = "GET") =>
    onRequest(
      { request: new Request(url, { headers, method }), env },
      async () => {
        assert.fail("Rejected request reached upstream");
      },
    );
  const authorized = { authorization: `Bearer ${browser}` };
  assert.equal((await check(site + path, {})).status, 401);
  assert.equal(
    (
      await check(site + path, {
        ...authorized,
        origin: "https://elsewhere.test",
      })
    ).status,
    403,
  );
  assert.equal((await check(`${site}${path}?limit=2`, authorized)).status, 400);
  assert.equal((await check(site + path, authorized, "POST")).status, 405);
});
