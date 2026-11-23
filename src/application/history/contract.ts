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

/** Decode the owner-reviewed public projection, excluding private ledger state. */
export const decodeHistoryPage = Schema.decodeUnknownSync(page);

/** Preserve null for missing operations in the retained History interface. */
export const decodeHistoryDetail = Schema.decodeUnknownSync(
  Schema.NullOr(record),
);
