import { decodeStorageSnapshot } from "../contracts/oci-storage.js";
import { readProxy } from "./read-proxy.js";

/** Bind the allowance route to the browser session and its own read credential. */
export interface OciStorageContext {
  request: Request;
  env: {
    BERTH_HISTORY_SITE_ORIGIN?: string;
    BERTH_HISTORY_ACCESS_TOKEN?: string;
    BERTH_HISTORY_UPSTREAM_TOKEN?: string;
    BERTH_INVENTORY_UPSTREAM_TOKEN?: string;
    BERTH_OCI_STORAGE_NEON_ORIGIN?: string;
    BERTH_OCI_STORAGE_UPSTREAM_TOKEN?: string;
  };
}

/** Forward exactly one owner-authorized saved reading request. */
export function ociStorageProxy(
  { request, env }: OciStorageContext,
  upstream: typeof fetch = fetch,
) {
  const token = env.BERTH_OCI_STORAGE_UPSTREAM_TOKEN;
  return readProxy(
    request,
    "oci-storage",
    {
      siteOrigin: env.BERTH_HISTORY_SITE_ORIGIN,
      browserToken: env.BERTH_HISTORY_ACCESS_TOKEN,
      upstreamOrigin: env.BERTH_OCI_STORAGE_NEON_ORIGIN,
      upstreamToken:
        token === env.BERTH_HISTORY_UPSTREAM_TOKEN ||
        token === env.BERTH_INVENTORY_UPSTREAM_TOKEN
          ? undefined
          : token,
      project: decodeStorageSnapshot,
    },
    upstream,
  );
}
