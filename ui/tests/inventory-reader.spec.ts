import "@angular/compiler";
import { Injector } from "@angular/core";
import { expect, test } from "@playwright/test";
import { createInventoryReader } from "../src/infrastructure/inventory-data-access";
import type { InventoryPage } from "../src/infrastructure/inventory-model";
import { INVENTORY_READER } from "../src/infrastructure/inventory-reader";
import { InventoryStore } from "../src/infrastructure/inventory-store";
import {
  createOwnerSession,
  OWNER_SESSION,
} from "../src/owner-access/owner-session";
import { inventoryPage, uncertain, verified } from "./inventory-fixture";

test("Inventory reader rejects malformed observations before verifying owner access", async () => {
  const calls: string[] = [];
  const page = inventoryPage([verified]);
  const owner = createOwnerSession(async (input) => {
    calls.push(String(input));
    const invalid = { ...verified, observedAt: "2026-02-31T00:00:00Z" };
    return Response.json(
      calls.length === 1 ? { ...page, items: [invalid] } : page,
    );
  });
  owner.connect("h".repeat(40));
  const reader = createInventoryReader(owner);
  await expect(reader.page(null, () => true)).resolves.toEqual({
    kind: "unavailable",
  });
  expect(owner.status()).toBe("unverified");
  await expect(reader.page(uncertain.instance, () => true)).resolves.toEqual({
    kind: "success",
    value: page,
  });
  expect(owner.status()).toBe("verified");
  expect(calls).toEqual([
    "/api/inventory?limit=20",
    `/api/inventory?limit=20&after=${uncertain.instance}`,
  ]);
});

test("Inventory discards an old success after reconnect before dispatching the next read", async () => {
  const oldPage = Promise.withResolvers<InventoryPage>();
  const newPage = Promise.withResolvers<InventoryPage>();
  const owner = createOwnerSession(async () => Response.error());
  let calls = 0;
  const injector = Injector.create({
    providers: [
      InventoryStore,
      { provide: OWNER_SESSION, useValue: owner },
      {
        provide: INVENTORY_READER,
        useValue: {
          async page() {
            calls++;
            return {
              kind: "success",
              value: await (calls === 1 ? oldPage.promise : newPage.promise),
            };
          },
        },
      },
    ],
  });
  const store = injector.get(InventoryStore);
  try {
    owner.connect("h".repeat(40));
    store.open();
    expect(calls).toBe(1);
    owner.disconnect();
    expect(store.snapshot()).toBeNull();
    owner.connect("i".repeat(40));
    store.open();
    expect(calls).toBe(1);
    oldPage.resolve(inventoryPage([verified]));
    await expect.poll(() => calls).toBe(2);
    expect(store.rows()).toEqual([]);
    newPage.resolve(inventoryPage([uncertain]));
    await expect.poll(() => store.rows()).toEqual([uncertain]);
  } finally {
    injector.destroy();
  }
});
