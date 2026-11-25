import { historyReader as retainedHistoryReader } from "../retained-trial-ledger/history.ts";
import type { HistoryRead } from "./contract.ts";

/** Assemble the read capability for the History HTTP handler. */
export function historyReader(
  env: Record<string, string | undefined>,
): HistoryRead {
  return retainedHistoryReader(env);
}
