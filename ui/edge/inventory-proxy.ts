import { projectInventoryPage } from "./inventory-page.js";
import { readProxy } from "./read-proxy.js";

/** Inventory shares the owner's browser access and uses its own upstream bindings. */
export interface InventoryContext {
  request: Request;
  env: {
    BERTH_HISTORY_SITE_ORIGIN?: string;
    BERTH_HISTORY_ACCESS_TOKEN?: string;
    BERTH_HISTORY_UPSTREAM_TOKEN?: string;
    BERTH_INVENTORY_NEON_ORIGIN?: string;
    BERTH_INVENTORY_UPSTREAM_TOKEN?: string;
  };
}

/** Forward one bounded Inventory read using only the Inventory upstream credential. */
export function inventoryProxy(
  { request, env }: InventoryContext,
  upstream: typeof fetch = fetch,
): Promise<Response> {
  const token = env.BERTH_INVENTORY_UPSTREAM_TOKEN;
  return readProxy(
    request,
    "inventory",
    {
      siteOrigin: env.BERTH_HISTORY_SITE_ORIGIN,
      upstreamOrigin: env.BERTH_INVENTORY_NEON_ORIGIN,
      browserToken: env.BERTH_HISTORY_ACCESS_TOKEN,
      upstreamToken:
        token === env.BERTH_HISTORY_UPSTREAM_TOKEN ? undefined : token,
      project: projectInventoryPage,
    },
    upstream,
  );
}
