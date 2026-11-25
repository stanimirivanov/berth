import * as Schema from "effect/Schema";

/** Maximum number of records per History request and response page. */
export const historyPageLimit = 50;

const operationId = Schema.String.check(
  Schema.isPattern(
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
  ),
);
const timestampPattern =
  /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const timestamp = Schema.String.check(
  Schema.makeFilter((value) => {
    if (!timestampPattern.test(value) || !Number.isFinite(Date.parse(value)))
      return false;
    const date = value.slice(0, 10);
    return new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date;
  }),
);
const count = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
);
const budget = Schema.Struct({
  used: count,
  limit: count.check(Schema.isGreaterThanOrEqualTo(1)),
}).check(Schema.makeFilter(({ used, limit }) => used <= limit));
const record = Schema.Struct({
  operation: operationId,
  startedAt: timestamp,
  expiresAt: timestamp,
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
    requests: count,
    mutations: count,
  }).check(
    Schema.makeFilter(({ requests, mutations }) => mutations <= requests),
  ),
});
const page = Schema.Struct({
  items: Schema.Array(record).check(Schema.isMaxLength(historyPageLimit)),
  next: Schema.NullOr(operationId),
});

/** Match canonical identifiers in History request paths, cursors and retained rows. */
export const isHistoryOperationId = Schema.is(operationId);

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
