import type { PersistedState } from "alchemy/State/State";
import type { BucketAttributes } from "../providers/oci/bucket.js";
import type { ProbeReceipt } from "../providers/oci/trial-object.js";
import type { LedgerClaim, LedgerDatabase, TrialRecord } from "./ledger.js";
/** Closed durable phase vocabulary; terminal status comes from the ledger, not a local cache. */
export type Phase = "bucket" | "object" | "observe" | "cleanup";
/** One fixed operation checkpoint, owned by the same fence as all ledger requests. */
export interface ExecutionSnapshot {
  trial: TrialRecord;
  phase: Phase;
  bucket: BucketAttributes | null;
  receipt: ProbeReceipt | null;
  pending_upload: boolean;
  failed: boolean;
  cleanup_requested: boolean;
  object_removed: boolean;
  reason: string | null;
}
/** Duplicate and busy deliveries cannot authorize work. */
export type OpenExecution =
  | { kind: "claimed"; claim: LedgerClaim; snapshot: ExecutionSnapshot }
  | { kind: "terminal" | "duplicate" | "busy" | "expired" };
/** Restricted owner-installed SQL functions; all writes capture the immutable ledger claim. */
export function executorStore(db: LedgerDatabase) {
  /** Never expose SQL details or infer rejection after a lost commit response. */
  async function call<T>(sql: string, values: unknown[]): Promise<T> {
    try {
      return (await db.query(sql, values)).rows[0]?.result as T;
    } catch {
      throw Error("Executor state unavailable; reconcile without retry");
    }
  }
  return {
    /** Atomic claim and durable delivery deduplication under the operation row lock. */
    open: (operation: string, owner: string, delivery: string) =>
      call<OpenExecution>("SELECT berth_executor.open($1,$2,$3) AS result", [
        operation,
        owner,
        delivery,
      ]),
    /** Guarded checkpoint commands and closed Alchemy bucket state. */
    access: <T = unknown>(
      claim: LedgerClaim,
      command: string,
      value: unknown = null,
    ) =>
      call<T>("SELECT berth_executor.access($1,$2,$3,$4,$5::jsonb) AS result", [
        claim.operation,
        claim.owner,
        claim.generation,
        command,
        JSON.stringify(value),
      ]),
    /** Read-only receipt projection; it does not claim or resume work. */
    report: (operation: string) =>
      call<ExecutionSnapshot>("SELECT berth_executor.report($1) AS result", [
        operation,
      ]),
    /** API cleanup admission sets a durable flag; provider ownership is checked during execution. */
    cleanup: async (operation: string) => {
      await call("SELECT berth_executor.cleanup($1) AS result", [operation]);
      return { operation, status: "cleanup-requested" as const };
    },
  };
}
/** Public Alchemy payload accepted only by the closed SQL validator. */
export type BucketState = PersistedState;
