import {
  type MonthlyEvidence,
  type MonthlyOutcome,
  type MonthlyReading,
  missingMonthlyEvidence,
  outboundZones,
  type UsageSku,
} from "../../application/oci-storage/contract.ts";

const day = 86_400_000;
const requestSku = "B91627";
const reportLimit = 200;
const skus = [requestSku, ...Object.keys(outboundZones)];

/** A validated response and billing month establish provenance without establishing a cutoff. */
type ReportBasis = Pick<
  MonthlyReading,
  "periodStart" | "periodEnd" | "respondedAt" | "observedAt" | "expiresAt"
>;

/** Preserve the JSON number's decimal spelling for lossless upward rounding. */
class UsageQuantity {
  readonly decimal: string;

  constructor(decimal: string) {
    this.decimal = decimal;
  }
}

/** Keep a private distinction between an actual JSON number and a lookalike field or string. */
function parseUsage(text: string): unknown {
  return JSON.parse(
    text,
    (key: string, value: unknown, context?: { source?: string }) =>
      key === "computedQuantity" &&
      typeof value === "number" &&
      Number.isFinite(value) &&
      context?.source
        ? new UsageQuantity(context.source)
        : value,
  );
}

/** Normalize a provider decimal by a power of ten and round upward before reducing to a safe integer. */
function roundUsage(value: unknown, power: number): number | undefined {
  if (!(value instanceof UsageQuantity) || value.decimal.length > 80) return;
  const parts = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(value.decimal);
  if (!parts?.[1]) return;
  const fraction = parts[2] ?? "";
  const exponent = Number(parts[3] ?? 0);
  if (Math.abs(exponent) > 400) return;
  const scale = exponent + power - fraction.length;
  const digits = BigInt(parts[1] + fraction);
  const divisor = 10n ** BigInt(Math.max(0, -scale));
  const rounded =
    scale >= 0
      ? digits * 10n ** BigInt(scale)
      : (digits + divisor - 1n) / divisor;
  return rounded <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(rounded)
    : undefined;
}

/** OCI returns UTC day boundaries with or without a zero fractional second. */
function utcDay(value: unknown): number {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d\d-\d\dT00:00:00(?:\.0{1,3})?(?:Z|\+00:00)$/.test(value)
  )
    return NaN;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) &&
    new Date(parsed).toISOString().slice(0, 10) === value.slice(0, 10)
    ? parsed
    : NaN;
}

/** View records from the Usage API as untrusted until their meter and fields are validated. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Represent one non-overlapping SKU subtotal. Omitted days and zero rows do not prove full coverage. */
function reportedUsage(
  rows: Record<string, unknown>[],
  sku: UsageSku,
  through: number,
  basis: ReportBasis,
): MonthlyOutcome {
  const unverified = {
    gap: "usage-coverage-unverified",
    reading: null,
  } as const;
  const unit = sku === requestSku ? "10K Requests" : "GB";
  const power = sku === requestSku ? 4 : 3;
  const start = Date.parse(basis.periodStart);
  const days = new Set<number>();
  let used = 0;
  let last = start;
  for (const row of rows) {
    const from = utcDay(row.timeUsageStarted);
    const to = utcDay(row.timeUsageEnded);
    const amount = roundUsage(row.computedQuantity, power);
    if (
      row.unit !== unit ||
      (row.isForecast !== undefined &&
        row.isForecast !== null &&
        row.isForecast !== false) ||
      !(from >= start && to === from + day && to <= through) ||
      days.has(from) ||
      amount === undefined ||
      !Number.isSafeInteger(used + amount)
    )
      return unverified;
    days.add(from);
    used += amount;
    last = Math.max(last, to);
  }
  if (used === 0) return unverified;
  return {
    gap: "accounting-cutoff-unverified",
    reading: {
      ...basis,
      sku,
      used,
      source: "OCI Usage API",
      accountingCutoff: null,
      coverage: "partial",
      reportedThrough: new Date(last).toISOString(),
    },
  };
}

/** Split the fixed tenant-wide report into the billed request SKU and one observed outbound zone. */
function monthlyReport(
  value: unknown,
  through: number,
  basis: ReportBasis,
): MonthlyEvidence {
  const items = asRecord(value)?.items;
  if (!Array.isArray(items) || items.length >= reportLimit)
    return missingMonthlyEvidence("usage-coverage-unverified");
  const requestRows: Record<string, unknown>[] = [];
  const outboundRows: Record<string, unknown>[] = [];
  const zones = new Set<keyof typeof outboundZones>();
  for (const item of items) {
    const row = asRecord(item);
    const sku = row?.skuPartNumber;
    if (row && sku === requestSku) {
      requestRows.push(row);
    } else if (
      row &&
      (sku === "B88327" || sku === "B93455" || sku === "B93456")
    ) {
      outboundRows.push(row);
      zones.add(sku);
    } else {
      return missingMonthlyEvidence("usage-coverage-unverified");
    }
  }
  const zone = zones.values().next().value;
  return {
    requests: reportedUsage(requestRows, requestSku, through, basis),
    outbound:
      zone && zones.size === 1
        ? reportedUsage(outboundRows, zone, through, basis)
        : {
            gap:
              zones.size > 1
                ? "outbound-scope-unverified"
                : "usage-coverage-unverified",
            reading: null,
          },
  };
}

/** The fixed Usage API report dimensions and decoder used by the signed allowance collector. */
export const monthlyUsageReport = {
  skus,
  limit: reportLimit,
  parse: parseUsage,
  project: monthlyReport,
};
