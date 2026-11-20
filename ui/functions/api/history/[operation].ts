import {
  type HistoryContext,
  historyProxy,
} from "../../../edge/history-proxy.js";

/** Cloudflare Pages entrypoint for the private history read API. */
export function onRequest(context: HistoryContext, upstream?: typeof fetch) {
  return historyProxy(context, upstream);
}
