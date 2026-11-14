import {
  type MetricObservation,
  metricNames,
  readMetric,
  type UsageTarget,
  type UsageTransport,
  usageQuery,
} from "../providers/oci/usage.js";
import type { LedgerClaim, LedgerDatabase } from "./ledger.js";
/** App-owned demonstration threshold, unrelated to a provider allowance or hard cap. */
export const usageThreshold = {
  bytes: 2097152,
  warningPercent: 50,
  enforcement: "app" as const,
  providerHardCap: false,
};
/** Equality warns; unknown observations never manufacture zero or a warning. */
export function thresholdWarning(metric: {
  status: string;
  value: number | null;
}) {
  return (
    metric.status === "known" &&
    metric.value !== null &&
    Number.isFinite(metric.value) &&
    metric.value >= (usageThreshold.bytes * usageThreshold.warningPercent) / 100
  );
}
/** SQL owns cadence, fencing and warning dedup; no raw provider payload crosses this port. */
export function usageStore(db: LedgerDatabase) {
  /** Fixed guarded commands; SQL exceptions remain private and are never automatically retried. */
  async function command<T>(
    claim: LedgerClaim,
    action: string,
    value: unknown = null,
  ): Promise<T> {
    try {
      return (
        await db.query(
          "SELECT berth_usage.control($1,$2,$3,$4,$5::jsonb) AS result",
          [
            claim.operation,
            claim.owner,
            claim.generation,
            action,
            JSON.stringify(value),
          ],
        )
      ).rows[0]?.result as T;
    } catch {
      throw Error("Usage persistence unavailable");
    }
  }
  return {
    /** Set verified upload time once, before entering the observation phase. */
    uploaded: (c: LedgerClaim) => command(c, "uploaded"),
    /** Atomically spend this hourly opportunity even if the process later crashes. */
    due: (c: LedgerClaim) => command<UsageTarget | null>(c, "due"),
    /** Recheck cleanup/cancellation and server clock immediately before each metered request. */
    allowed: (c: LedgerClaim) => command<boolean>(c, "allowed"),
    /** Persist an allowlisted sample set and insert at most one threshold warning. */
    record: (c: LedgerClaim, samples: MetricObservation[]) =>
      command(c, "record", {
        samples,
        warning: thresholdWarning(
          samples.find((sample) => sample.metric === "StoredBytes") ?? {
            status: "unknown",
            value: null,
          },
        ),
      }),
    /** End observation without delaying teardown, preserving all earlier evidence. */
    close: (c: LedgerClaim) => command(c, "close"),
    /** Private API projection includes retained history and never contacts OCI. */
    report: async (operation: string) => {
      try {
        return (
          await db.query("SELECT berth_usage.report($1) AS result", [operation])
        ).rows[0]?.result;
      } catch {
        throw Error("Usage report unavailable");
      }
    },
  };
}
/** Collect only when SQL grants a due slot; each of the three requests has its own reservation. */
export async function collectUsage(
  db: LedgerDatabase,
  claim: LedgerClaim,
  transport: UsageTransport,
  dispatch: <T>(send: () => Promise<T>) => Promise<T>,
  signal: AbortSignal,
  now: () => number = Date.now,
) {
  const store = usageStore(db),
    target = await store.due(claim);
  if (!target) return;
  const samples: MetricObservation[] = [];
  for (const metric of metricNames) {
    if (signal.aborted || !(await store.allowed(claim))) break;
    let raw: unknown;
    try {
      raw = await dispatch(() =>
        transport(usageQuery(metric, target, now()), signal),
      );
    } catch {
      raw = null;
    }
    samples.push(readMetric(metric, raw, target, now()));
  }
  // A partial/failed poll remains explicitly unknown; cleanup can proceed independently.
  while (samples.length < 3) {
    const metric = metricNames[samples.length];
    if (!metric) break;
    samples.push(readMetric(metric, null, target, now()));
  }
  await store.record(claim, samples);
}
