import { type RetryContext, retryProxy } from "../../../edge/retry-proxy.js";

/** Same-origin entry point for the separately authenticated Retry service. */
export function onRequest(
  context: RetryContext,
  upstream: typeof fetch = fetch,
) {
  return retryProxy(context, upstream);
}
