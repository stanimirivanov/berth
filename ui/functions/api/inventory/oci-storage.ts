import {
  type OciStorageContext,
  ociStorageProxy,
} from "../../../edge/oci-storage-proxy.js";

/** Cloudflare Pages entry point for the owner's saved OCI allowance reading. */
export function onRequest(context: OciStorageContext, upstream?: typeof fetch) {
  return ociStorageProxy(context, upstream);
}
