import {
  type HistoryContext,
  historyProxy,
} from "../../../edge/history-proxy.js";

/** Keep unmatched history paths at the private JSON API boundary. */
export function onRequest(context: HistoryContext, upstream?: typeof fetch) {
  return historyProxy(context, upstream);
}
