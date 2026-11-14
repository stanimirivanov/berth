/** Parameterized SQL port; caller supplies bounded autocommit connections, never provider credentials. */
export interface LedgerDatabase {
  /** Executes one atomic owner-installed ledger function. */
  query(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }>;
}
/** Immutable identity of one execution; a new invocation must use a fresh owner UUID. */
export interface LedgerClaim {
  readonly operation: string;
  readonly owner: string;
  readonly generation: string;
}
/** Public identifiers and digest only; SQL generates names, marker and four-hour timestamps. */
export interface TrialIntent {
  operation: string;
  compartment: string;
  region: string;
  namespace: string;
  digest: string;
  monitoringLimit: number;
  neonLimit: number;
}
/** Fixed actions determine their meter; callers cannot label normal work as cleanup. */
export type TrialAction =
  | "create_bucket"
  | "put_object"
  | "inspect"
  | "inspect_cleanup"
  | "delete_object"
  | "delete_bucket"
  | "monitor"
  | "invoke";
/** Stable identity returned by intent creation; complete details remain available through read. */
export interface TrialRecord {
  operation: string;
  compartment: string;
  region: string;
  namespace: string;
  digest: string;
  outcome: "active" | "needs-reconciliation" | "succeeded" | "failed";
  marker: string;
  bucket: string;
  object_name: string;
  started_at: string;
  expires_at: string;
}
/** A duplicate receipt is evidence only, never another dispatch authorization. */
export interface Reservation {
  id: string;
  fresh: boolean;
}
/**
 * Thin ledger boundary. No cloud calls, DDL, retries, counter refunds or implicit
 * reacquisition. A failed response may have committed; reconcile stable IDs.
 * Lease fencing protects SQL, not an already dispatched external request.
 */
export function makeLedger(db: LedgerDatabase) {
  /** Discard all database/provider details; uncertainty must never trigger blind retry. */
  async function call<T>(sql: string, values: unknown[]): Promise<T> {
    try {
      return (await db.query(sql, values)).rows[0]?.result as T;
    } catch {
      throw Error(
        "Ledger rejected or outcome uncertain; reconcile without retry",
      );
    }
  }
  /** Captured claim fields are passed with every guarded operation. */
  const identity = (c: LedgerClaim) => [c.operation, c.owner, c.generation];
  /** Fixed control commands share the authoritative SQL fence. */
  const control = (
    c: LedgerClaim,
    op: string,
    id: string | null = null,
    outcome: string | null = null,
  ) =>
    call<unknown>("SELECT berth_ledger.control($1,$2,$3,$4,$5,$6) AS result", [
      ...identity(c),
      op,
      id,
      outcome,
    ]);
  return {
    /** Idempotent matching intent creation; a different active trial is rejected. */
    start: (i: TrialIntent) =>
      call<TrialRecord>(
        "SELECT berth_ledger.start_trial($1,$2,$3,$4,$5,$6,$7) AS result",
        [
          i.operation,
          i.compartment,
          i.region,
          i.namespace,
          i.digest,
          i.monitoringLimit,
          i.neonLimit,
        ],
      ),
    /** Explicit claim; repeating an active owner observes the claim without extending it. */
    claim: async (operation: string, owner: string, ttl = 30) =>
      Object.freeze(
        await call<LedgerClaim>(
          "SELECT berth_ledger.claim($1,$2,$3) AS result",
          [operation, owner, ttl],
        ),
      ),
    /** Charges one of three action attempts even if the caller crashes before dispatch. */
    begin: (c: LedgerClaim, id: string, action: TrialAction) =>
      call<string>(
        "SELECT berth_ledger.begin_attempt($1,$2,$3,$4,$5) AS result",
        [...identity(c), id, action],
      ),
    /** Charges one underlying request before dispatch; unknown delivery remains unresolved and spent. */
    reserve: (c: LedgerClaim, attempt: string, id: string) =>
      call<Reservation>(
        "SELECT berth_ledger.reserve($1,$2,$3,$4,$5) AS result",
        [...identity(c), attempt, id],
      ),
    /** Only definite responses or independently established reconciliation may settle a request. */
    settle: (
      c: LedgerClaim,
      id: string,
      outcome: "succeeded" | "rejected",
      basis:
        | "provider-response"
        | "reconciled-provider"
        | "read-only-interruption"
        | "not-dispatched",
    ) =>
      call<unknown>("SELECT berth_ledger.settle($1,$2,$3,$4,$5,$6) AS result", [
        ...identity(c),
        id,
        outcome,
        basis,
      ]),
    /** Complete an attempt only after all its dispatches have definite outcomes. */
    end: (c: LedgerClaim, id: string, outcome: "succeeded" | "failed") =>
      control(c, "end", id, outcome),
    /** Unresolved trials retain the single-active slot even after lease expiry. */
    finish: (
      c: LedgerClaim,
      outcome: "succeeded" | "failed" | "needs-reconciliation",
    ) => control(c, "finish", null, outcome),
    /** Read bounded durable evidence under the current generation. */
    read: (c: LedgerClaim) => control(c, "read"),
    /** Renew only a still-valid execution; never resurrect an expired generation. */
    renew: (c: LedgerClaim) => control(c, "renew"),
    /** Release ownership without clearing attempts, reservations or unknown mutations. */
    release: (c: LedgerClaim) => control(c, "release"),
  };
}
