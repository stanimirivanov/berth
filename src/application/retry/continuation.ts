import * as Schema from "effect/Schema";

const id = Schema.String.check(
  Schema.isPattern(
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
  ),
);
const time = Schema.String.check(
  Schema.makeFilter((value) => Number.isFinite(Date.parse(value))),
);
const target = Schema.Struct({
  region: Schema.String,
  compartment: Schema.String,
  namespace: Schema.String,
  bucket: Schema.String,
  instance: Schema.NullOr(id),
});
const ownerProcedure = Schema.Literal(
  "https://github.com/stanimirivanov/berth/blob/main/docs/trial/retry-continuation.md",
);
const continuation = Schema.Union([
  Schema.Struct({
    operation: id,
    stage: Schema.Literals(["needs-attention", "checking-provider"]),
    reason: Schema.Literals([
      "reconciliation-required",
      "reconciliation-in-progress",
      "reconciliation-stopped",
      "original-authority-unavailable",
      "source-not-safe",
      "preparation-required",
      "preparation-changed",
      "preparation-withdrawn",
      "proposal-expired",
      "executor-slot-unavailable",
    ]),
    ownerProcedure,
  }),
  Schema.Struct({
    operation: id,
    stage: Schema.Literals(["continuing-provisioning", "completed"]),
    scope: Schema.Literal("original-window"),
    expiresAt: time,
    creationCutoff: time,
  }),
  Schema.Struct({
    operation: id,
    stage: Schema.Literal("waiting-for-approval"),
    proposal: id,
    target,
    steps: Schema.Union([
      Schema.Tuple([
        Schema.Literal("create-bucket"),
        Schema.Literal("upload-fixture"),
        Schema.Literal("verify-and-clean-up"),
      ]),
      Schema.Tuple([
        Schema.Literal("upload-fixture"),
        Schema.Literal("verify-and-remove-fixture"),
      ]),
    ]),
    evidence: Schema.Struct({
      observedAt: time,
      allowanceCheckedAt: time,
      iamCheckedAt: time,
      reference: Schema.String,
    }),
    startsAt: time,
    creationCutoff: time,
    expiresAt: time,
    approveBy: time,
    limits: Schema.Struct({
      normal: Schema.Literal(160),
      cleanup: Schema.Literal(40),
      monitoring: Schema.Literal(20),
      application: Schema.Literal(64),
      applicationCleanup: Schema.Literal(12),
      attemptsPerAction: Schema.Literal(3),
    }),
  }),
  Schema.Struct({
    operation: id,
    stage: Schema.Literals([
      "continuing-provisioning",
      "completed",
      "needs-attention",
    ]),
    scope: Schema.Literal("after-expiry"),
    continuation: id,
    authorization: Schema.Literal("approved"),
    progress: Schema.Literals([
      "awaiting-activation",
      "executing",
      "completed",
      "stopped",
    ]),
    reason: Schema.NullOr(
      Schema.Literals([
        "authorization-withdrawn",
        "source-changed",
        "activation-expired",
        "execution-stopped",
      ]),
    ),
    approvedAt: time,
    startsAt: time,
    expiresAt: time,
    ownerProcedure,
  }),
]);

/** Redact private SQL fields before an owner can recover a proposal or its retained decision. */
export const decodeContinuation = Schema.decodeUnknownSync(
  Schema.NullOr(continuation),
);

/** Owner Retry reads a retained continuation or accepts exactly one previously displayed proposal. */
export type RetryContinuation = (
  operation: string,
  proposal: string | null,
) => Promise<ReturnType<typeof decodeContinuation>>;
