import { historyApi } from "./history-api.js";
import { historyReader } from "./history-runtime.js";

/** Separate import-inert history root; no trial token, expiry gate, OCI key or schedules. */
export default historyApi(
  process.env.BERTH_HISTORY_TOKEN ?? "",
  historyReader(process.env),
);
