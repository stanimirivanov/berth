import { randomUUID } from "node:crypto";
import type { RetryAction } from "./api.ts";
import type { RetryLedger, RetryProof } from "./contract.ts";
import type { RetryObservation, RetryObserver } from "./observation.ts";

/** Claim once, commit every reservation before its GET, and account under the selected execution scope. */
export function retryActions(
  ledger: RetryLedger,
  provider: RetryObserver,
): RetryAction {
  return async (action, operation) => {
    if (action === "status") return ledger.status(operation);

    const claim = randomUUID();
    const pending = await ledger.begin(operation, claim);
    if (!pending) return null;
    if (pending.status.operation !== operation)
      throw Error("Retry claim mismatch");
    if (pending.kind === "recorded") return pending.status;
    const deadline = Date.parse(pending.deadline);
    const target = pending.target;
    if (target.bucket !== `berth-${operation.replaceAll("-", "")}`)
      throw Error("Retry target mismatch");

    /** Return an inconclusive stop on provider failure while retaining the already charged read. */
    async function observe(
      probe: "bucket" | "list",
    ): Promise<RetryObservation | { kind: "reservation-refused" }> {
      const allowed = await ledger.reserve(operation, claim, probe);
      if (!allowed) return { kind: "reservation-refused" };
      try {
        return await provider.observe(target, probe, deadline);
      } catch {
        return { kind: "inconclusive" };
      }
    }

    let proof: RetryProof = { kind: "scope-unavailable" };
    if (provider.supports(target)) {
      proof = await observe("bucket");
      if (proof.kind === "not-found") proof = await observe("list");
    }
    return ledger.finish(
      operation,
      claim,
      proof.kind === "absent"
        ? { ...proof, observedAt: new Date().toISOString() }
        : proof,
    );
  };
}
