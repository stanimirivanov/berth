/** Decimal-byte ceiling used for an eligible Always Free-only tenancy. */
export const storageAllowance = 20_000_000_000;

/** Fixed owner-visible explanations. Internal OCI data stays inside the collector. */
export type StorageGap =
  | "account-unverified"
  | "region-coverage-unverified"
  | "storage-coverage-unverified"
  | "response-time-unverified"
  | "accounting-cutoff-unverified"
  | "oci-unavailable";

/** A dated Limits observation. respondedAt is the HTTP date, not an accounting cutoff. */
export interface StorageReading {
  usedBytes: number;
  limitBytes: typeof storageAllowance;
  observedAt: string;
  respondedAt: string;
  accountingCutoff: string | null;
  expiresAt: string;
  source: "OCI";
}

/** Reviewed outbound origin-zone SKUs and their visible provider scopes. */
export const outboundZones = {
  B88327: "North America, Europe and UK",
  B93455: "APAC, Japan and South America",
  B93456: "Middle East and Africa",
} as const;

/** The billed SKU for Object Storage API request usage. */
export const requestUsageSku = "B91627";

/** Admit only the reviewed outbound origin-zone SKUs. */
export function isOutboundUsageSku(
  value: unknown,
): value is keyof typeof outboundZones {
  return typeof value === "string" && Object.hasOwn(outboundZones, value);
}

/** The monthly billing meters tracked independently of point-in-time storage. */
export type MonthlyMeter = "requests" | "outbound";

/** Identifies the billed request meter or one outbound origin zone. */
export type UsageSku = typeof requestUsageSku | keyof typeof outboundZones;

/** A fixed reason why a dated monthly reading cannot establish remaining allowance. */
export type MonthlyGap =
  | "account-unverified"
  | "oci-unavailable"
  | "response-time-unverified"
  | "usage-coverage-unverified"
  | "outbound-scope-unverified"
  | "accounting-cutoff-unverified";

/** Fixed monthly ceilings in requests and thousandths of a provider GB, respectively. */
export const monthlyAllowance: Record<MonthlyMeter, number> = {
  requests: 50_000,
  outbound: 10_000_000,
};

/** Usage is an integer count of requests or thousandths of one provider GB, according to SKU. */
export interface MonthlyReading {
  sku: UsageSku;
  used: number;
  source: "OCI Usage API";
  periodStart: string;
  periodEnd: string;
  observedAt: string;
  respondedAt: string;
  reportedThrough: string;
  coverage: "partial" | "complete";
  accountingCutoff: string | null;
  expiresAt: string;
}

/** The last attempt and last usable observation may describe different collections. */
export interface MonthlyOutcome {
  gap: MonthlyGap | null;
  reading: MonthlyReading | null;
}

/** Each meter retains its own gap even though both use the same collection slot. */
export type MonthlyEvidence = Record<MonthlyMeter, MonthlyOutcome>;

/** Get the bounds of the UTC billing month containing the given instant. */
export function usagePeriod(at: number) {
  const boundary = new Date(at);
  boundary.setUTCDate(1);
  boundary.setUTCHours(0, 0, 0, 0);
  const periodStart = boundary.toISOString();
  boundary.setUTCMonth(boundary.getUTCMonth() + 1);
  return { periodStart, periodEnd: boundary.toISOString() };
}

/** Schedule provenance for the latest claim and the previous settled outcome. */
export interface StorageProvenance {
  lastSettledAttemptAt: string | null;
  pending: {
    startedAt: string | null;
    overdueAt: string | null;
    previousObservationStale?: true;
  } | null;
}

/** The latest slot, latest settled gap and last retained reading can describe different attempts. */
export interface StorageSnapshot {
  attemptedAt: string | null;
  gap: StorageGap | null;
  reading: StorageReading | null;
  provenance?: StorageProvenance;
  monthly?: MonthlyEvidence;
}

/** Require an ordinary JSON object before reading interpreted fields. */
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw Error("Invalid storage observation");
  }
  return value as Record<string, unknown>;
}

/** Only canonical UTC dates round-trip between PostgreSQL, Pages and the browser. */
function timestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

/** Return only declared reading fields. Provider-specific attributes never reach the browser. */
function reading(value: unknown): StorageReading {
  const {
    usedBytes,
    limitBytes,
    observedAt,
    respondedAt,
    accountingCutoff,
    expiresAt,
    source,
  } = record(value);
  if (
    typeof usedBytes !== "number" ||
    !Number.isSafeInteger(usedBytes) ||
    usedBytes < 0 ||
    limitBytes !== storageAllowance ||
    source !== "OCI" ||
    !timestamp(observedAt) ||
    !timestamp(respondedAt) ||
    !timestamp(expiresAt) ||
    (accountingCutoff !== null &&
      (!timestamp(accountingCutoff) || accountingCutoff > respondedAt)) ||
    respondedAt > observedAt ||
    Date.parse(expiresAt) >
      Date.parse(accountingCutoff ?? respondedAt) + 7_200_000 ||
    observedAt >= expiresAt
  ) {
    throw Error("Invalid storage reading");
  }
  return {
    usedBytes,
    limitBytes,
    observedAt,
    respondedAt,
    accountingCutoff,
    expiresAt,
    source,
  };
}

/** Validate units by SKU and require complete billing coverage before a cutoff can qualify. */
function monthlyReading(value: unknown, meter: MonthlyMeter): MonthlyReading {
  const {
    sku,
    used,
    source,
    periodStart,
    periodEnd,
    observedAt,
    respondedAt,
    reportedThrough,
    coverage,
    accountingCutoff,
    expiresAt,
  } = record(value);
  const validSku =
    (sku === requestUsageSku && meter === "requests") ||
    (isOutboundUsageSku(sku) && meter === "outbound");
  if (
    !validSku ||
    typeof used !== "number" ||
    !Number.isSafeInteger(used) ||
    used < 0 ||
    source !== "OCI Usage API" ||
    !timestamp(periodStart) ||
    !timestamp(periodEnd) ||
    !timestamp(observedAt) ||
    !timestamp(respondedAt) ||
    !timestamp(reportedThrough) ||
    !timestamp(expiresAt) ||
    (coverage !== "complete" && coverage !== "partial") ||
    (coverage === "complete"
      ? accountingCutoff !== reportedThrough
      : accountingCutoff !== null || used === 0)
  )
    throw Error("Invalid monthly OCI reading");
  const period = usagePeriod(Date.parse(observedAt));
  const maxExpiry =
    coverage === "complete"
      ? Date.parse(observedAt) + 86_400_000
      : Date.parse(respondedAt) + 7_200_000;
  if (
    periodStart !== period.periodStart ||
    periodEnd !== period.periodEnd ||
    reportedThrough <= periodStart ||
    reportedThrough > respondedAt ||
    respondedAt > observedAt ||
    observedAt >= expiresAt ||
    expiresAt > periodEnd ||
    Date.parse(expiresAt) > maxExpiry
  )
    throw Error("Invalid monthly OCI period");
  return {
    sku,
    used,
    source,
    periodStart,
    periodEnd,
    observedAt,
    respondedAt,
    reportedThrough,
    coverage,
    accountingCutoff: coverage === "complete" ? reportedThrough : null,
    expiresAt,
  };
}

/** A complete retained reading can coexist with the previous attempt's failure. */
function monthlyOutcome(value: unknown, meter: MonthlyMeter): MonthlyOutcome {
  const { gap, reading } = record(value);
  if (
    gap !== null &&
    gap !== "account-unverified" &&
    gap !== "oci-unavailable" &&
    gap !== "response-time-unverified" &&
    gap !== "usage-coverage-unverified" &&
    gap !== "accounting-cutoff-unverified" &&
    !(meter === "outbound" && gap === "outbound-scope-unverified")
  )
    throw Error("Invalid monthly OCI gap");
  const observation = reading === null ? null : monthlyReading(reading, meter);
  if (gap === null && observation?.coverage !== "complete")
    throw Error("Complete monthly OCI coverage is missing");
  return { gap, reading: observation };
}

/** Read independently retained monthly meters when a newer collector has supplied them. */
function decodeMonthly(value: unknown): MonthlyEvidence {
  const { requests, outbound } = record(value);
  return {
    requests: monthlyOutcome(requests, "requests"),
    outbound: monthlyOutcome(outbound, "outbound"),
  };
}

/** Associate new provenance with the latest slot. A migrated pending claim may have no start time. */
function decodeProvenance(
  value: unknown,
  attemptedAt: string | null,
): StorageProvenance {
  const { lastSettledAttemptAt, pending } = record(value);
  if (
    attemptedAt === null ||
    (lastSettledAttemptAt !== null && !timestamp(lastSettledAttemptAt))
  ) {
    throw Error("Invalid storage collection provenance");
  }
  if (pending === null) {
    if (lastSettledAttemptAt !== attemptedAt) {
      throw Error("Invalid settled storage collection");
    }
    return { lastSettledAttemptAt, pending: null };
  }
  const { startedAt, overdueAt, previousObservationStale } = record(pending);
  if (
    (lastSettledAttemptAt !== null && lastSettledAttemptAt >= attemptedAt) ||
    (previousObservationStale !== undefined &&
      previousObservationStale !== true) ||
    (!(startedAt === null && overdueAt === null) &&
      (!timestamp(startedAt) ||
        !timestamp(overdueAt) ||
        startedAt < attemptedAt ||
        overdueAt <= startedAt))
  ) {
    throw Error("Invalid pending storage collection");
  }
  return {
    lastSettledAttemptAt,
    pending: {
      startedAt,
      overdueAt,
      ...(previousObservationStale ? { previousObservationStale } : {}),
    },
  };
}

/** Decode the saved result at each trust boundary and discard unknown attributes. */
export function decodeStorageSnapshot(value: unknown): StorageSnapshot {
  const {
    attemptedAt,
    gap,
    reading: saved,
    provenance,
    monthly,
  } = record(value);
  if (
    (attemptedAt !== null && !timestamp(attemptedAt)) ||
    (gap !== null &&
      gap !== "account-unverified" &&
      gap !== "region-coverage-unverified" &&
      gap !== "storage-coverage-unverified" &&
      gap !== "response-time-unverified" &&
      gap !== "accounting-cutoff-unverified" &&
      gap !== "oci-unavailable") ||
    (attemptedAt === null &&
      (gap !== null || saved !== null || monthly !== undefined))
  ) {
    throw Error("Invalid storage snapshot");
  }
  const observation = saved === null ? null : reading(saved);
  if (observation?.accountingCutoff === null && gap === null) {
    throw Error("Storage accounting cutoff is missing");
  }
  let collection: StorageProvenance | undefined;
  if (provenance !== undefined) {
    collection = decodeProvenance(provenance, attemptedAt);
  } else if (
    attemptedAt !== null &&
    gap === null &&
    (!observation || observation.observedAt < attemptedAt)
  ) {
    // A settled success requires an observation at or after its slot, and a settled failure has a gap.
    collection = {
      lastSettledAttemptAt: null,
      pending: { startedAt: null, overdueAt: null },
    };
  }
  return {
    attemptedAt,
    gap,
    reading: observation,
    ...(collection === undefined ? {} : { provenance: collection }),
    ...(monthly === undefined ? {} : { monthly: decodeMonthly(monthly) }),
  };
}
