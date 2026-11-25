import { readProxy } from "./read-proxy.js";

/** Pages runtime bindings. Both tokens are secrets, supplied independently. */
interface HistoryBindings {
  BERTH_HISTORY_SITE_ORIGIN?: string;
  BERTH_HISTORY_NEON_ORIGIN?: string;
  BERTH_HISTORY_ACCESS_TOKEN?: string;
  BERTH_HISTORY_UPSTREAM_TOKEN?: string;
}

/** Minimal Cloudflare Pages context consumed by the history routes. */
export interface HistoryContext {
  request: Request;
  env: HistoryBindings;
}

/** Keep the History route and its bindings independent of the Inventory upstream. */
export function historyProxy(
  { request, env }: HistoryContext,
  upstream: typeof fetch = fetch,
): Promise<Response> {
  return readProxy(
    request,
    "history",
    {
      siteOrigin: env.BERTH_HISTORY_SITE_ORIGIN,
      upstreamOrigin: env.BERTH_HISTORY_NEON_ORIGIN,
      browserToken: env.BERTH_HISTORY_ACCESS_TOKEN,
      upstreamToken: env.BERTH_HISTORY_UPSTREAM_TOKEN,
    },
    upstream,
  );
}
