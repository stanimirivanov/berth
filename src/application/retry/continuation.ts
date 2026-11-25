import * as Schema from "effect/Schema";
import { retryId, retryTargetFields, retryTimestamp } from "./contract.ts";

/** Preserve PostgreSQL's sub-millisecond digits when comparing decoded timestamps. */
function timestampMicros(value: string) {
  const remainder = /[.]\d{3}(\d{1,3})/.exec(value)?.[1];
  return (
    BigInt(Date.parse(value)) * 1000n + BigInt(remainder?.padEnd(3, "0") ?? "0")
  );
}

const ownerProcedure = Schema.Literal(
  "https://github.com/stanimirivanov/berth/blob/main/docs/trial/retry-continuation.md",
);
const stop = Schema.Union([
  Schema.Struct({
    operation: retryId,
    stage: Schema.Literal("checking-provider"),
    reason: Schema.Literal("reconciliation-in-progress"),
    ownerProcedure,
  }),
  Schema.Struct({
    operation: retryId,
    stage: Schema.Literal("needs-attention"),
    reason: Schema.Literals([
      "reconciliation-required",
      "reconciliation-stopped",
      "original-authority-unavailable",
      "source-not-safe",
      "preparation-required",
      "preparation-changed",
      "preparation-withdrawn",
      "proposal-expired",
      "executor-slot-unavailable",
      "allowance-evidence-unqualified",
      "credential-evidence-unqualified",
      "cleanup-evidence-unqualified",
    ]),
    ownerProcedure,
  }),
]);
const proposalFields = {
  operation: retryId,
  stage: Schema.Literal("waiting-for-approval"),
  proposal: retryId,
  evidence: Schema.Struct({
    observedAt: retryTimestamp,
    allowanceCheckedAt: retryTimestamp,
    iamCheckedAt: retryTimestamp,
    reference: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,80}$/)),
  }),
  startsAt: retryTimestamp,
  creationCutoff: retryTimestamp,
  expiresAt: retryTimestamp,
  approveBy: retryTimestamp,
  limits: Schema.Struct({
    normal: Schema.Literal(160),
    cleanup: Schema.Literal(40),
    monitoring: Schema.Literal(20),
    application: Schema.Literal(64),
    applicationCleanup: Schema.Literal(12),
    attemptsPerAction: Schema.Literal(3),
  }),
};
const proposal = Schema.Union([
  Schema.Struct({
    ...proposalFields,
    target: Schema.Struct({ ...retryTargetFields, instance: Schema.Null }),
    steps: Schema.Tuple([
      Schema.Literal("create-bucket"),
      Schema.Literal("upload-fixture"),
      Schema.Literal("verify-and-clean-up"),
    ]),
  }),
  Schema.Struct({
    ...proposalFields,
    target: Schema.Struct({ ...retryTargetFields, instance: retryId }),
    steps: Schema.Tuple([
      Schema.Literal("upload-fixture"),
      Schema.Literal("verify-and-remove-fixture"),
    ]),
  }),
]).check(
  Schema.makeFilter(({ startsAt, creationCutoff, expiresAt, approveBy }) => {
    const cutoff = timestampMicros(creationCutoff);
    const expiry = timestampMicros(expiresAt);
    return (
      timestampMicros(startsAt) < cutoff &&
      cutoff < expiry &&
      timestampMicros(approveBy) <= cutoff
    );
  }),
);
const approvalFields = {
  operation: retryId,
  scope: Schema.Literal("after-expiry"),
  continuation: retryId,
  authorization: Schema.Literal("approved"),
  approvedAt: retryTimestamp,
  startsAt: retryTimestamp,
  expiresAt: retryTimestamp,
  ownerProcedure,
};
const approval = Schema.Union([
  Schema.Struct({
    ...approvalFields,
    stage: Schema.Literal("continuing-provisioning"),
    progress: Schema.Literals(["awaiting-activation", "executing"]),
    reason: Schema.Null,
  }),
  Schema.Struct({
    ...approvalFields,
    stage: Schema.Literal("completed"),
    progress: Schema.Literal("completed"),
    reason: Schema.Null,
  }),
  Schema.Struct({
    ...approvalFields,
    stage: Schema.Literal("needs-attention"),
    progress: Schema.Literal("stopped"),
    reason: Schema.Literals([
      "authorization-withdrawn",
      "source-changed",
      "activation-expired",
      "execution-stopped",
    ]),
  }),
]).check(
  Schema.makeFilter(({ startsAt, expiresAt, approvedAt }) => {
    const expiry = timestampMicros(expiresAt);
    return (
      timestampMicros(startsAt) < expiry && timestampMicros(approvedAt) < expiry
    );
  }),
);

/** Decode a status read, keeping private retained and provider fields out of the UI. */
export const decodeContinuation = Schema.decodeUnknownSync(
  Schema.NullOr(
    Schema.Union([
      stop,
      Schema.Struct({
        operation: retryId,
        stage: Schema.Literals(["continuing-provisioning", "completed"]),
        scope: Schema.Literal("original-window"),
        expiresAt: retryTimestamp,
        creationCutoff: retryTimestamp,
      }),
      proposal,
      approval,
    ]),
  ),
);

/** An approval must yield a retained authorization or null if it is unavailable. */
export const decodeApproval = Schema.decodeUnknownSync(Schema.NullOr(approval));

/** Owner Retry reads a retained continuation or accepts exactly one previously displayed proposal. */
export type RetryContinuation = (
  operation: string,
  proposal: string | null,
) => Promise<ReturnType<typeof decodeContinuation>>;
