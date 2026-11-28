import {
  type MonthlyGap,
  type MonthlyMeter,
  type MonthlyOutcome,
  type MonthlyReading,
  monthlyAllowance,
} from "../../contracts/oci-storage";

/** A pending claim's status and its effect on observations from prior collections. */
export interface CollectionView {
  status: "pending" | "overdue" | "unknown";
  previousObservationStale: boolean;
}

/** Allowance warning thresholds expressed as percentages of the fixed limit. */
export type WarningThreshold = 80 | 95 | 100;

/** A dated monthly observation with independently qualified headroom, in the meter's saved units. */
export interface MonthlyMeterView {
  reading: MonthlyReading | null;
  status: "Stale" | "Current" | "Unknown";
  reason:
    | MonthlyGap
    | "no-reading"
    | "saved-read-unavailable"
    | "previous-period"
    | "expired"
    | null;
  remaining: number | null;
  warning: WarningThreshold | null;
}

/** Use the same thresholds for each qualified OCI allowance reading. */
export function warningThreshold(
  used: number,
  limit: number,
): WarningThreshold | null {
  const fraction = used / limit;
  if (fraction >= 1) {
    return 100;
  }
  if (fraction >= 0.95) {
    return 95;
  }
  return fraction >= 0.8 ? 80 : null;
}

/** Keep the dated observation visible when gaps or expiry make its headroom unknown. */
export function monthlyMeterView(
  meter: MonthlyMeter,
  outcome: MonthlyOutcome | undefined,
  context: {
    now: number;
    unavailable: boolean;
    previousObservationStale: boolean;
  },
): MonthlyMeterView {
  const reading = outcome?.reading ?? null;
  const cutoff = reading?.accountingCutoff ?? null;
  const expired =
    reading !== null && context.now >= Date.parse(reading.expiresAt);
  const gap = outcome?.gap;
  const stale =
    reading !== null &&
    (context.unavailable ||
      expired ||
      context.previousObservationStale ||
      (gap != null &&
        (gap !== "accounting-cutoff-unverified" || cutoff !== null)));
  const current = reading !== null && cutoff !== null && !stale;
  const limit = monthlyAllowance[meter];
  let reason: MonthlyMeterView["reason"] =
    gap === undefined ? "no-reading" : gap;
  if (context.unavailable) {
    reason = "saved-read-unavailable";
  } else if (reading && context.now >= Date.parse(reading.periodEnd)) {
    reason = "previous-period";
  } else if (expired) {
    reason = "expired";
  }
  return {
    reading,
    status: stale ? "Stale" : current ? "Current" : "Unknown",
    reason,
    remaining: current ? Math.max(0, limit - reading.used) : null,
    warning: current ? warningThreshold(reading.used, limit) : null,
  };
}
