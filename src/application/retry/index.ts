import { retryApi } from "./api.js";
import { retryRuntime } from "./runtime.js";

/** Isolated owner reconciliation root. It has no schedule or provider mutation port. */
export default retryApi(
  process.env.BERTH_RETRY_OWNER_CREDENTIAL ?? "",
  retryRuntime(process.env),
);
