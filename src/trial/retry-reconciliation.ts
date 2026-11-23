import { randomUUID } from "node:crypto";
import type {
  RetryObservation,
  RetryObserver,
  RetryTarget,
} from "../providers/oci/retry-observation.js";
import type { RetryAction, RetryStatus } from "./retry-api.js";

/** Parameterized database port. It cannot select or mutate trial tables under the retry role. */
export interface RetryDatabase {
  query(
    text: string,
    args: unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }>;
}

/** Only a newly committed claim receives the private target and deadline. */
interface BeginRetry {
  status: RetryStatus;
  target?: RetryTarget;
  deadline?: string;
}

/** Claim once, commit every reservation before its GET, and finish without changing the old operation. */
export function retryActions(
  db: RetryDatabase,
  provider: RetryObserver,
): RetryAction {
  /** The installed functions own eligibility, metering and all sanitized result codes. */
  async function call<T>(sql: string, args: unknown[]): Promise<T> {
    return (await db.query(sql, args)).rows[0]?.result as T;
  }

  return async (action, operation) => {
    if (action === "status")
      return call("SELECT berth_retry.status($1) AS result", [operation]);

    const claim = randomUUID();
    const pending = await call<BeginRetry | null>(
      "SELECT berth_retry.begin($1,$2) AS result",
      [operation, claim],
    );
    if (!pending?.target || !pending.deadline) return pending?.status ?? null;
    const deadline = Date.parse(pending.deadline);
    const target = pending.target;

    /** Return an inconclusive stop on provider failure while retaining the already charged read. */
    async function observe(
      probe: "bucket" | "list",
    ): Promise<RetryObservation | { kind: "reservation-refused" }> {
      const allowed = await call<boolean>(
        "SELECT berth_retry.reserve($1,$2,$3) AS result",
        [operation, claim, probe],
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
    return call<RetryStatus>(
      "SELECT berth_retry.finish($1,$2,$3::jsonb) AS result",
      [
        operation,
        claim,
        JSON.stringify(
          proof.kind === "absent"
            ? { ...proof, observedAt: new Date().toISOString() }
            : proof,
        ),
      ],
    );
  };
}
