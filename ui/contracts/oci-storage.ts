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

/** A failed attempt can retain a reading from an earlier collection. */
export interface StorageSnapshot {
  attemptedAt: string | null;
  gap: StorageGap | null;
  reading: StorageReading | null;
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

/** Decode the saved result at each trust boundary and discard unknown attributes. */
export function decodeStorageSnapshot(value: unknown): StorageSnapshot {
  const { attemptedAt, gap, reading: saved } = record(value);
  if (
    (attemptedAt !== null && !timestamp(attemptedAt)) ||
    (gap !== null &&
      gap !== "account-unverified" &&
      gap !== "region-coverage-unverified" &&
      gap !== "storage-coverage-unverified" &&
      gap !== "response-time-unverified" &&
      gap !== "accounting-cutoff-unverified" &&
      gap !== "oci-unavailable") ||
    (attemptedAt === null && (gap !== null || saved !== null))
  ) {
    throw Error("Invalid storage snapshot");
  }
  const observation = saved === null ? null : reading(saved);
  if (observation?.accountingCutoff === null && gap === null) {
    throw Error("Storage accounting cutoff is missing");
  }
  return { attemptedAt, gap, reading: observation };
}
