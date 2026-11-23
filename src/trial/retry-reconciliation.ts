import { randomUUID } from "node:crypto";
import type {
  RetryObservation,
  RetryObserver,
} from "../providers/oci/retry-observation.js";
import type { RetryAction } from "./retry-api.js";
import {
  decodeRetryClaim,
  decodeRetryReservation,
  decodeRetryStatus,
} from "./retry-contract.js";

/** Parameterized database port. It cannot select or mutate trial tables under the retry role. */
export interface RetryDatabase {
  query(
    text: string,
    args: unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }>;
}

/** Claim once, commit every reservation before its GET, and account under the selected execution scope. */
export function retryActions(
  db: RetryDatabase,
  provider: RetryObserver,
): RetryAction {
  /** The installed functions own eligibility, metering and all sanitized result codes. */
  async function call(sql: string, args: unknown[]): Promise<unknown> {
    const { rows } = await db.query(sql, args);
    if (rows.length !== 1) throw Error("Retry database result unavailable");
    return rows[0]?.result;
  }

  return async (action, operation) => {
    if (action === "status")
      return decodeRetryStatus(
        await call("SELECT berth_retry.status($1) AS result", [operation]),
      );

    const claim = randomUUID();
    const pending = decodeRetryClaim(
      await call("SELECT berth_retry.begin($1,$2) AS result", [
        operation,
        claim,
      ]),
    );
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
      const allowed = decodeRetryReservation(
        await call("SELECT berth_retry.reserve($1,$2,$3) AS result", [
          operation,
          claim,
          probe,
        ]),
      );
      if (!allowed) return { kind: "reservation-refused" };
      try {
        return await provider.observe(target, probe, deadline);
      } catch {
        return { kind: "inconclusive" };
      }
    }

    let proof:
      | RetryObservation
      | { kind: "scope-unavailable" | "reservation-refused" } = {
      kind: "scope-unavailable",
    };
    if (provider.supports(target)) {
      proof = await observe("bucket");
      if (proof.kind === "not-found") proof = await observe("list");
    }
    return decodeRetryStatus(
      await call("SELECT berth_retry.finish($1,$2,$3::jsonb) AS result", [
        operation,
        claim,
        JSON.stringify(
          proof.kind === "absent"
            ? { ...proof, observedAt: new Date().toISOString() }
            : proof,
        ),
      ]),
    );
  };
}
