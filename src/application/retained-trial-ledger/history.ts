import {
  assertExecutorPrivileges,
  restrictedConnection,
} from "../../trial/executor-security.ts";
import { decodeHistoryDetail, decodeHistoryPage } from "../history/contract.ts";
import { type RetainedTrialDatabase, retainedTrialResult } from "./sql.ts";

export { restrictedConnection as retainedHistoryConnection };

/** Enter the read-only transaction before checking the retained History login. */
export async function prepareRetainedHistoryReader(db: RetainedTrialDatabase) {
  await db.query("BEGIN READ ONLY");
  await assertExecutorPrivileges(db);
}

/** Read only the existing owner-reviewed History functions on a read-only connection. */
export function retainedHistoryLedger(db: RetainedTrialDatabase) {
  /** Preserve the existing History error contract and redact SQL diagnostics. */
  async function read<T>(
    decode: (value: unknown) => T,
    text: string,
    parameters: unknown[],
  ): Promise<T> {
    try {
      return decode(await retainedTrialResult(db, text, parameters));
    } catch {
      throw Error("Executor state unavailable; reconcile without retry");
    }
  }

  return {
    /** Fetch one bounded page without applying the original operation expiry. */
    list: (before: string | null = null, limit = 20) =>
      read(
        decodeHistoryPage,
        "SELECT berth_executor.history_page($1,$2) AS result",
        [before, limit],
      ),
    /** Fetch the retained summary or null, using no execution capability. */
    detail: (operation: string) =>
      read(
        decodeHistoryDetail,
        "SELECT berth_executor.history_detail($1) AS result",
        [operation],
      ),
  };
}
