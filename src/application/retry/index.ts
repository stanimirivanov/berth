import { retryApi } from "./api.ts";
import { retryContinuationRuntime, retryRuntime } from "./runtime.ts";

/** Isolated owner reconciliation root. Provider writes remain with the separately admitted executor. */
export default retryApi(
  process.env.BERTH_RETRY_OWNER_CREDENTIAL ?? "",
  retryRuntime(process.env),
  Date.now,
  retryContinuationRuntime(process.env),
);
