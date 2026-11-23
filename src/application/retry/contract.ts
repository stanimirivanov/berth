import * as Schema from "effect/Schema";
import type { RetryObservation } from "../../providers/oci/retry-observation.ts";

const operation = Schema.String.check(
  Schema.isPattern(
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
  ),
);
const timestamp = Schema.String.check(
  Schema.isPattern(
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|[+-]\d\d:\d\d)$/,
  ),
  Schema.makeFilter((value) => Number.isFinite(Date.parse(value))),
);
const commonStatus = {
  operation,
  scope: Schema.Literals(["original-window", "after-expiry"]),
  observedAt: Schema.NullOr(timestamp),
  startedAt: timestamp,
  checks: Schema.Struct({
    used: Schema.Literals([0, 1, 2]),
    limit: Schema.Literal(2),
  }),
};
const checking = Schema.Struct({
  ...commonStatus,
  stage: Schema.Literal("checking-provider"),
  result: Schema.Null,
  reason: Schema.Null,
  ownerProcedure: Schema.Null,
});
const status = Schema.Union([
  checking,
  Schema.Struct({
    ...commonStatus,
    stage: Schema.Literal("completed"),
    result: Schema.Literals(["owned-instance", "safe-write-needed"]),
    reason: Schema.Null,
    ownerProcedure: Schema.Null,
    observedAt: timestamp,
  }),
  Schema.Struct({
    ...commonStatus,
    stage: Schema.Literal("needs-attention"),
    result: Schema.Null,
    reason: Schema.Literals([
      "operation-completed",
      "operation-busy",
      "cleanup-started",
      "creation-window-closed",
      "operation-changed",
      "read-scope-unavailable",
      "read-access-unavailable",
      "normal-budget-exhausted",
      "ownership-conflict",
      "evidence-unavailable",
      "newer-removal-recorded",
      "bucket-configuration-drift",
      "unresolved-prior-write",
      "expected-instance-not-found",
      "provider-check-inconclusive",
      "check-interrupted",
    ]),
    ownerProcedure: Schema.Literals([
      "https://github.com/stanimirivanov/berth/blob/main/docs/trial/owner-recovery.md#4-stop-conditions-and-leftovers",
      "https://github.com/stanimirivanov/berth/blob/main/docs/trial/retry-reconciliation.md#installation-prerequisites",
    ]),
  }),
]);

/** Public retry projection derived from the same codec used at the SQL and HTTP boundaries. */
export type RetryStatus = typeof status.Type;

/** Decode and project the approved fields, stripping excess private values at every struct. */
export const decodeRetryStatus = Schema.decodeUnknownSync(
  Schema.NullOr(status),
);

/** Only a newly committed claim has the target and deadline required to send a provider request. */
export const decodeRetryClaim = Schema.decodeUnknownSync(
  Schema.NullOr(
    Schema.Union([
      Schema.Struct({ kind: Schema.Literal("recorded"), status }),
      Schema.Struct({
        kind: Schema.Literal("claimed"),
        status: checking,
        deadline: timestamp,
        target: Schema.Struct({
          region: Schema.String.check(
            Schema.isPattern(/^[a-z]{2}-[a-z]+-[1-9]$/),
          ),
          namespace: Schema.String.check(
            Schema.isPattern(/^[A-Za-z0-9_-]{1,64}$/),
          ),
          compartment: Schema.String.check(
            Schema.isPattern(
              /^ocid1[.]compartment[.]oc1[.][.][A-Za-z0-9]{1,128}$/,
            ),
          ),
          bucket: Schema.String.check(Schema.isPattern(/^berth-[0-9a-f]{32}$/)),
        }),
      }),
    ]),
  ),
);

/** A durable reservation is a Boolean. Only the true branch permits dispatch. */
export const decodeRetryReservation = Schema.decodeUnknownSync(Schema.Boolean);

/** Normalized provider evidence with optional observation time, or a bounded local stop. */
export type RetryProof =
  | RetryObservation
  | { kind: "scope-unavailable" | "reservation-refused" }
  | { kind: "absent"; observedAt: string };

/** The four durable operations used by reconciliation, in claim and reservation order. */
export interface RetryLedger {
  status(operation: string): Promise<RetryStatus | null>;
  begin(
    operation: string,
    claim: string,
  ): Promise<ReturnType<typeof decodeRetryClaim>>;
  reserve(
    operation: string,
    claim: string,
    probe: "bucket" | "list",
  ): Promise<boolean>;
  finish(
    operation: string,
    claim: string,
    proof: RetryProof,
  ): Promise<RetryStatus | null>;
}
