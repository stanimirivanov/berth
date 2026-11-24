import {
  type InventoryContext,
  inventoryProxy,
} from "../../../edge/inventory-proxy.js";

/** Cloudflare Pages entry point for the authorized Inventory read. */
export function onRequest(context: InventoryContext, upstream?: typeof fetch) {
  return inventoryProxy(context, upstream);
}
