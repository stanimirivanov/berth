/** Fixed planning envelope, not a provider cap or authorization to deploy.
 * Sixty-four application units include twelve protected cleanup units. Thirty-two
 * extra calls model retries/rejections; four more cover a fifteen-minute owner
 * shutdown interval. Those extras are assumptions requiring review, not enforced
 * provider limits. Every modeled second is charged to active capacity as well as
 * checked against waiting capacity, so no CPU/wait split is inferred from latency.
 */
const plan = Object.freeze({
  applicationCalls: 64,
  cleanupCalls: 12,
  perCallSeconds: 60,
  overheadCalls: 32,
  shutdownCalls: 4,
  shutdownMinutes: 15,
  totalCapacitySeconds: 6000,
});

/** Treat untrusted JSON as an object without coercing strings into usage numbers. */
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Capacity is finite and nonnegative; counts and bytes additionally require integers. */
function amount(value: unknown, integer = false): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= Number.MAX_SAFE_INTEGER &&
    (!integer || Number.isSafeInteger(value))
  );
}

/**
 * Review a normalized single cumulative provider snapshot and a measured probe.
 * This offline function authenticates no provider and grants no admission. The
 * caller must review project/period provenance and the asserted coverage against
 * the original evidence. Missing or incomplete history never becomes zero usage.
 * A valid report still requires explicit review of the overhead assumptions and
 * cannot be copied into the live Headroom contract as verified remaining quota.
 */
export function qualifyFunctions(input: unknown, now: number) {
  const e = record(input),
    probe = record(e.probe),
    history = record(e.history);
  const reasons: string[] = [];
  if (
    !amount(now) ||
    !amount(e.checkedAt) ||
    e.checkedAt > now ||
    now - e.checkedAt > 86400000
  )
    reasons.push("snapshot-stale-or-unknown");
  if (
    probe.unit !== "milliseconds" ||
    !amount(probe.clientMs) ||
    !amount(probe.handlerMs) ||
    probe.handlerMs === 0 ||
    probe.clientMs < probe.handlerMs ||
    probe.clientMs * 20 > 60000
  )
    reasons.push("probe-missing-or-exceeds-planning-margin");
  const covers = history.covers;
  const required = [
    "accepted",
    "rejected",
    "load-failure",
    "retry",
    "expired",
    "post-response",
  ];
  if (
    history.source !== "provider-meter" ||
    history.complete !== true ||
    history.truncated !== false ||
    history.unit !== "capacity-seconds" ||
    !Array.isArray(covers) ||
    required.some((kind) => !covers.includes(kind))
  )
    reasons.push("history-incomplete-or-wrong-units");
  // One cumulative period total only: never sum overlapping snapshots or log rows.
  const observations = history.observations;
  const row = record(
    Array.isArray(observations) && observations.length === 1
      ? observations[0]
      : undefined,
  );
  if (
    !Array.isArray(observations) ||
    observations.length !== 1 ||
    typeof row.id !== "string" ||
    !/^[A-Za-z0-9_-]{1,80}$/.test(row.id) ||
    !amount(row.active) ||
    !amount(row.waiting) ||
    !amount(row.invocations, true) ||
    !amount(row.transferBytes, true)
  )
    reasons.push("missing-duplicate-or-invalid-period-total");
  const remaining = reasons.length
    ? null
    : {
        activeCapacitySeconds: 36000 - Number(row.active),
        waitingCapacitySeconds: 1440000 - Number(row.waiting),
        invocations: 1000000 - Number(row.invocations),
      };
  if (
    remaining &&
    (remaining.activeCapacitySeconds < plan.totalCapacitySeconds ||
      remaining.waitingCapacitySeconds < plan.totalCapacitySeconds ||
      remaining.invocations < 100)
  )
    reasons.push("insufficient-capacity-including-cleanup-and-shutdown");
  return {
    verdict: reasons.length ? ("no-go" as const) : ("review-required" as const),
    admission: false as const,
    reasons,
    plan,
    remaining,
    limitations: [
      "provider-provenance-not-authenticated",
      "overhead-is-an-assumption-not-a-cap",
      "postgres-and-shared-transfer-headroom-require-separate-evidence",
    ],
  };
}
