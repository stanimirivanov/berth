import { validTimestamp } from "../../observation-time";
import { isOperationId } from "../../operation-id";

/** Owner guidance for authorizing or recovering a linked continuation. */
export const continuationProcedure =
  "https://github.com/stanimirivanov/berth/blob/main/docs/trial/retry-continuation.md";
const recovery =
  "https://github.com/stanimirivanov/berth/blob/main/docs/trial/";
/** Owner recovery when execution authority has stopped. */
export const recoveryStop = `${recovery}owner-recovery.md#4-stop-conditions-and-leftovers`;
const procedureLinks = new Set([
  continuationProcedure,
  recoveryStop,
  `${recovery}retry-reconciliation.md#installation-prerequisites`,
]);

/** Fixed explanations for retained stop and check reasons. */
export const reasons = {
  "reconciliation-required": "Run a scoped provider check before continuing.",
  "reconciliation-in-progress":
    "Berth is checking the provider. Check retry status to see the result.",
  "reconciliation-stopped": "The provider check did not qualify further work.",
  "original-authority-unavailable":
    "The original cutoff, budget, cleanup state, or authorization prevents further work.",
  "source-not-safe":
    "The recorded provider evidence cannot establish a safe continuation.",
  "preparation-required":
    "The owner must prepare current Free-plan, credential and cleanup evidence before approval.",
  "preparation-changed":
    "The prepared evidence has changed. Review a fresh proposal before approving.",
  "preparation-withdrawn": "The owner withdrew this preparation.",
  "proposal-expired":
    "This proposal expired. Review a fresh proposal before approving.",
  "executor-slot-unavailable": "An existing operation holds the executor slot.",
  "allowance-evidence-unqualified":
    "Free-plan allowance evidence is missing, stale, or insufficient.",
  "credential-evidence-unqualified":
    "The restricted credential or IAM evidence did not qualify.",
  "cleanup-evidence-unqualified":
    "Independent owner cleanup access has not been verified.",
  "authorization-withdrawn":
    "The owner withdrew this continuation's write authorization.",
  "source-changed": "The source operation or its evidence changed.",
  "activation-expired":
    "The approved continuation missed its activation window.",
  "execution-stopped":
    "Continuation stopped. Review the recorded evidence and cleanup procedure.",
  "operation-completed": "The original operation is already complete.",
  "operation-busy":
    "The original executor is still working. Review its status before retrying.",
  "cleanup-started": "Cleanup has started. Further provisioning is blocked.",
  "creation-window-closed": "The original creation cutoff has passed.",
  "operation-changed": "The operation changed during the provider check.",
  "read-scope-unavailable":
    "The provider read scope is unavailable for this operation.",
  "read-access-unavailable":
    "The provider read credential could not verify this operation.",
  "normal-budget-exhausted": "The original normal request budget is exhausted.",
  "ownership-conflict":
    "The provider evidence does not establish ownership of this bucket.",
  "evidence-unavailable": "Berth could not confirm the retained evidence.",
  "newer-removal-recorded": "Newer evidence records removal of this instance.",
  "bucket-configuration-drift":
    "The bucket configuration differs from the approved settings.",
  "unresolved-prior-write": "An earlier provider write is still unresolved.",
  "expected-instance-not-found": "The expected instance could not be verified.",
  "provider-check-inconclusive": "The bounded provider check was inconclusive.",
  "check-interrupted":
    "The provider check was interrupted. Review the retained evidence.",
} as const;

type Reason = keyof typeof reasons;
/** Display labels for Retry stages. */
export const stageLabels = {
  "checking-provider": "Checking provider",
  "waiting-for-approval": "Waiting for approval",
  "continuing-provisioning": "Continuing provisioning",
  completed: "Completed",
  "needs-attention": "Needs attention",
} as const;

/** Display labels for the closed list of proposal steps. */
export const stepLabels = {
  "create-bucket": "Create the private Standard bucket",
  "upload-fixture": "Upload the fixed fixture",
  "verify-and-clean-up": "Verify the fixture and clean up the new resources",
  "verify-and-remove-fixture":
    "Verify and remove the fixture while preserving the original bucket",
} as const;

/** Public fields from the protected Retry service, with proposal fields required together. */
export interface RetryProposal {
  operation: string;
  stage: "waiting-for-approval";
  proposal: string;
  target: {
    region: string;
    compartment: string;
    namespace: string;
    bucket: string;
    instance: string | null;
  };
  steps: (keyof typeof stepLabels)[];
  evidence: {
    observedAt: string;
    allowanceCheckedAt: string;
    iamCheckedAt: string;
    reference: string;
  };
  startsAt: string;
  creationCutoff: string;
  expiresAt: string;
  approveBy: string;
  limits: {
    normal: number;
    cleanup: number;
    monitoring: number;
    application: number;
    applicationCleanup: number;
    attemptsPerAction: number;
  };
}

/** Stage, linked authorization and original cutoff remain distinct. */
export type RetryStatus =
  | RetryProposal
  | {
      operation: string;
      stage: "checking-provider" | "needs-attention";
      reason: Reason;
      ownerProcedure: string;
      checkedScope?: "original-window" | "after-expiry";
    }
  | {
      operation: string;
      stage: "continuing-provisioning" | "completed";
      scope: "original-window";
      expiresAt: string;
      creationCutoff: string;
    }
  | {
      operation: string;
      stage: "continuing-provisioning" | "completed" | "needs-attention";
      scope: "after-expiry";
      authorization: "approved";
      continuation: string;
      progress: "awaiting-activation" | "executing" | "completed" | "stopped";
      reason: Reason | null;
      ownerProcedure: string;
      approvedAt: string;
      startsAt: string;
      expiresAt: string;
    };

/** Require an object before reading a wire field. */
function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw Error();
  }
  return value as Record<string, unknown>;
}

/** Match bounded wire identifier strings without coercion. */
function matches(value: unknown, pattern: RegExp): value is string {
  return typeof value === "string" && pattern.test(value);
}

/** Validate the operation and owner guidance before exposing a stage to the panel. */
export function retryStatus(
  raw: unknown,
  operation: string,
  approved?: string,
): RetryStatus {
  const value = object(raw);
  const stage = value.stage;
  if (
    value.operation !== operation ||
    typeof stage !== "string" ||
    !Object.hasOwn(stageLabels, stage)
  ) {
    throw Error();
  }
  if (
    approved !== undefined &&
    (value.authorization !== "approved" || value.continuation !== approved)
  ) {
    throw Error();
  }
  if (approved === undefined && stage === "waiting-for-approval") {
    return decodeProposal(value, operation);
  }
  if (
    approved === undefined &&
    value.scope === "original-window" &&
    (stage === "completed" || stage === "continuing-provisioning")
  ) {
    if (
      !validTimestamp(value.expiresAt) ||
      !validTimestamp(value.creationCutoff)
    ) {
      throw Error();
    }
    return {
      operation,
      stage,
      scope: "original-window",
      expiresAt: value.expiresAt,
      creationCutoff: value.creationCutoff,
    };
  }
  const reason = value.reason;
  const link = value.ownerProcedure;
  if (typeof link !== "string" || !procedureLinks.has(link)) {
    throw Error();
  }
  if (value.authorization === "approved") {
    const {
      continuation: id,
      progress,
      approvedAt,
      startsAt,
      expiresAt,
    } = value;
    if (
      value.scope !== "after-expiry" ||
      typeof id !== "string" ||
      !isOperationId(id) ||
      !validTimestamp(approvedAt) ||
      !validTimestamp(startsAt) ||
      !validTimestamp(expiresAt)
    ) {
      throw Error();
    }
    const approval = {
      operation,
      continuation: id,
      scope: "after-expiry",
      authorization: "approved",
      ownerProcedure: link,
      approvedAt,
      startsAt,
      expiresAt,
    } as const;
    if (stage === "completed" && progress === "completed" && reason === null) {
      return { ...approval, stage, progress, reason };
    }
    if (
      stage === "continuing-provisioning" &&
      (progress === "awaiting-activation" || progress === "executing") &&
      reason === null
    ) {
      return { ...approval, stage, progress, reason };
    }
    if (
      stage === "needs-attention" &&
      progress === "stopped" &&
      knownReason(reason)
    ) {
      return { ...approval, stage, progress, reason };
    }
  } else if (
    approved === undefined &&
    ((stage === "checking-provider" &&
      reason === "reconciliation-in-progress") ||
      (stage === "needs-attention" && knownReason(reason)))
  ) {
    return { operation, stage, reason, ownerProcedure: link };
  }
  throw Error();
}

/** Qualify exact browser-visible proposal fields before an approval control can render. */
function decodeProposal(
  value: Record<string, unknown>,
  operation: string,
): RetryProposal {
  const id = value.proposal;
  const target = object(value.target);
  const evidence = object(value.evidence);
  const limits = object(value.limits);
  const { observedAt, iamCheckedAt, allowanceCheckedAt, reference } = evidence;
  const instance = target.instance;
  const steps = value.steps;
  const expected =
    instance === null
      ? (["create-bucket", "upload-fixture", "verify-and-clean-up"] as const)
      : (["upload-fixture", "verify-and-remove-fixture"] as const);
  const { startsAt, creationCutoff, expiresAt, approveBy } = value;
  if (
    typeof id !== "string" ||
    !isOperationId(id) ||
    target.bucket !== `berth-${operation.replaceAll("-", "")}` ||
    !matches(target.region, /^[a-z]{2}-[a-z]+-[1-9]$/) ||
    !matches(target.namespace, /^[A-Za-z0-9_-]{1,64}$/) ||
    !matches(
      target.compartment,
      /^ocid1\.compartment\.oc1\.\.[A-Za-z0-9]{1,128}$/,
    ) ||
    !(
      instance === null ||
      (typeof instance === "string" && isOperationId(instance))
    ) ||
    !Array.isArray(steps) ||
    steps.length !== expected.length ||
    expected.some((step, index) => steps[index] !== step) ||
    !validTimestamp(observedAt) ||
    !validTimestamp(iamCheckedAt) ||
    !validTimestamp(allowanceCheckedAt) ||
    !matches(reference, /^[A-Za-z0-9_-]{1,80}$/) ||
    !validTimestamp(startsAt) ||
    !validTimestamp(creationCutoff) ||
    !validTimestamp(expiresAt) ||
    !validTimestamp(approveBy) ||
    Date.parse(startsAt) >= Date.parse(creationCutoff) ||
    Date.parse(creationCutoff) >= Date.parse(expiresAt) ||
    Date.parse(approveBy) > Date.parse(creationCutoff) ||
    limits.normal !== 160 ||
    limits.cleanup !== 40 ||
    limits.monitoring !== 20 ||
    limits.application !== 64 ||
    limits.applicationCleanup !== 12 ||
    limits.attemptsPerAction !== 3
  ) {
    throw Error();
  }
  return {
    operation,
    stage: "waiting-for-approval",
    proposal: id,
    target: {
      region: target.region,
      namespace: target.namespace,
      compartment: target.compartment,
      bucket: target.bucket,
      instance,
    },
    steps: [...expected],
    evidence: { observedAt, iamCheckedAt, allowanceCheckedAt, reference },
    startsAt,
    creationCutoff,
    expiresAt,
    approveBy,
    limits: {
      normal: limits.normal,
      cleanup: limits.cleanup,
      monitoring: limits.monitoring,
      application: limits.application,
      applicationCleanup: limits.applicationCleanup,
      attemptsPerAction: limits.attemptsPerAction,
    },
  };
}

/** Convert a known code to a displayable reason without accepting text from upstream. */
function knownReason(reason: unknown): reason is Reason {
  return typeof reason === "string" && Object.hasOwn(reasons, reason);
}

/** Recover a reconciliation stop, including responses saved only by the POST. */
export function reconciliationStop(
  raw: unknown,
  operation: string,
): RetryStatus | null {
  const value = object(raw);
  if (value.operation !== operation) {
    throw Error();
  }
  if (value.stage === "completed" || value.stage === "checking-provider") {
    return null;
  }
  const { scope } = value;
  if (
    value.stage !== "needs-attention" ||
    (scope !== "original-window" && scope !== "after-expiry")
  ) {
    throw Error();
  }
  const checked = retryStatus(raw, operation);
  if (checked.stage !== "needs-attention" || "continuation" in checked) {
    throw Error();
  }
  return { ...checked, checkedScope: scope };
}

/** Permit a new check only when required or when the in-window check can be replaced after expiry. */
export function canCheckProvider(
  snapshot: RetryStatus | null,
  originalExpired: boolean,
) {
  return (
    snapshot?.stage === "needs-attention" &&
    !("continuation" in snapshot) &&
    (snapshot.reason === "reconciliation-required" ||
      (snapshot.checkedScope === "original-window" && originalExpired))
  );
}
