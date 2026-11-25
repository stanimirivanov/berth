import * as Schema from "effect/Schema";

const budget = Schema.Struct({ used: Schema.Number, limit: Schema.Number });
const record = Schema.Struct({
  operation: Schema.String,
  startedAt: Schema.String,
  expiresAt: Schema.String,
  outcome: Schema.Literals([
    "active",
    "needs-reconciliation",
    "succeeded",
    "failed",
  ]),
  phase: Schema.NullOr(
    Schema.Literals(["bucket", "object", "observe", "cleanup"]),
  ),
  pendingUpload: Schema.Boolean,
  cleanupRequested: Schema.Boolean,
  objectRemoved: Schema.Boolean,
  verdict: Schema.Literal("partial"),
  budgets: Schema.Struct({
    normal: budget,
    cleanup: budget,
    monitoring: budget,
    neon: budget,
  }),
  unresolved: Schema.Struct({
    requests: Schema.Number,
    mutations: Schema.Number,
  }),
});
const page = Schema.Struct({
  items: Schema.Array(record),
  next: Schema.NullOr(Schema.String),
});

/** One retained operation's public status and budget evidence. */
export type HistoryDetail = typeof record.Type;

/** Bounded page of public records and its continuation cursor. */
export type HistoryPage = typeof page.Type;

/** Read retained operation history independently of the original execution window. */
export interface HistoryRead {
  /**
   * Read the newest page by default or resume after the supplied cursor.
   * The limit defaults to 20 and accepts integers from 1 through 50.
   */
  list(before?: string | null, limit?: number): Promise<HistoryPage>;
  /** Read one retained record, returning null when the operation has no record. */
  detail(operation: string): Promise<HistoryDetail | null>;
}

/** Decode the owner-reviewed public projection, excluding private ledger state. */
export const decodeHistoryPage = Schema.decodeUnknownSync(page);

/** Preserve null for missing operations in the retained History interface. */
export const decodeHistoryDetail = Schema.decodeUnknownSync(
  Schema.NullOr(record),
);
