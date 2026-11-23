import assert from "node:assert/strict";
import test from "node:test";
import { retainedInventoryLedger } from "../src/application/retained-trial-ledger/inventory.ts";

test("the Inventory projection rejects presence without its dated observation or uncertainty reason", async () => {
  const at = "2026-01-01T10:00:00+00:00";
  const row = {
    instance: "10000000-0000-4000-8000-000000000001",
    displayName: "fixture",
    region: "eu-frankfurt-1",
    operation: "20000000-0000-4000-8000-000000000001",
    observedAt: at,
    presence: "verified-present",
    lastVerifiedAt: at,
    uncertainty: null,
  };
  const page = {
    offering: "oci-object-storage-bucket",
    coverage: "incomplete",
    items: [row],
    next: null,
  };
  const read = (result: unknown) =>
    retainedInventoryLedger({
      async query() {
        return { rows: [{ result }] };
      },
    }).page();

  assert.deepEqual(await read(page), page);
  assert.deepEqual(
    await read({ ...page, items: [{ ...row, privateProviderId: "fixture" }] }),
    page,
  );
  for (const malformed of [
    { lastVerifiedAt: null },
    { uncertainty: "delete-unresolved" },
    { presence: "uncertain", uncertainty: null },
    { observedAt: "invalid" },
  ]) {
    await assert.rejects(read({ ...page, items: [{ ...row, ...malformed }] }));
  }
});
