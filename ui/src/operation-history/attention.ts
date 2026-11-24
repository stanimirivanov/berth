import type { Operation } from "./history-reader";

const ownerRecovery =
  "https://github.com/stanimirivanov/berth/blob/main/docs/trial/owner-recovery.md";

/** Explain one follow-up flag and identify the relevant read-only guidance. */
interface AttentionReason {
  message: string;
  procedure: "stop" | "evidence";
}

/** Link only to the procedure sections for expiry or evidence reconciliation. */
export const ownerProcedures = {
  stop: {
    label: "Stop conditions",
    url: `${ownerRecovery}#4-stop-conditions-and-leftovers`,
  },
  evidence: {
    label: "Owner recovery evidence checks",
    url: `${ownerRecovery}#2-save-a-read-only-sql-snapshot-before-every-local-action`,
  },
} as const;

/** Return the active record’s expiry in Unix epoch milliseconds, if applicable. */
export function activeExpiry(operation: Operation): number | null {
  return operation.outcome === "active"
    ? Date.parse(operation.expiresAt)
    : null;
}

/** Derive follow-up in review order. Treat expiry at or before now as expired, in epoch milliseconds. */
export function attentionReasons(
  operation: Operation,
  now: number,
): AttentionReason[] {
  const reasons: AttentionReason[] = [];
  if (
    operation.outcome === "active" &&
    Date.parse(operation.expiresAt) <= now
  ) {
    reasons.push({
      message:
        "Execution window expired with the outcome still recorded as active.",
      procedure: "stop",
    });
  }
  if (operation.outcome === "needs-reconciliation") {
    reasons.push({
      message: "Recorded outcome requires reconciliation.",
      procedure: "evidence",
    });
  }
  if (operation.unresolved.requests > 0) {
    reasons.push({
      message: `Unresolved requests: ${operation.unresolved.requests}`,
      procedure: "evidence",
    });
  }
  if (operation.unresolved.mutations > 0) {
    reasons.push({
      message: `Unresolved mutations: ${operation.unresolved.mutations}`,
      procedure: "evidence",
    });
  }
  return reasons;
}
