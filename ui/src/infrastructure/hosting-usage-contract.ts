/** The meters are independent, even when two quotas measure the same service. */
export const hostingMeters = [
  {
    id: "cloudflare-requests",
    service: "Cloudflare Workers & Pages",
    title: "Function and Worker requests",
    scope: "Account",
    limit: 100_000,
    unit: "requests",
    period: "utc-day",
  },
  {
    id: "neon-compute",
    service: "Neon Postgres",
    title: "Postgres compute",
    scope: "Project",
    limit: 100,
    unit: "CU-hours",
    period: "billing",
  },
  {
    id: "neon-project-storage",
    service: "Neon Postgres",
    title: "Postgres storage",
    scope: "Project",
    limit: 1,
    unit: "GB",
    period: "continuous",
  },
  {
    id: "neon-organization-storage",
    service: "Neon Postgres",
    title: "Postgres storage",
    scope: "Organization",
    limit: 20,
    unit: "GB",
    period: "continuous",
  },
  {
    id: "neon-transfer",
    service: "Neon",
    title: "Shared public network transfer",
    scope: "Project",
    limit: 5,
    unit: "GB",
    period: "billing",
  },
  {
    id: "neon-invocations",
    service: "Neon Functions",
    title: "Invocations",
    scope: "Project",
    limit: 1_000_000,
    unit: "invocations",
    period: "billing",
  },
  {
    id: "neon-active",
    service: "Neon Functions",
    title: "Active capacity",
    scope: "Project",
    limit: 10,
    unit: "capacity-hours",
    period: "billing",
  },
  {
    id: "neon-waiting",
    service: "Neon Functions",
    title: "Waiting capacity",
    scope: "Project",
    limit: 400,
    unit: "capacity-hours",
    period: "billing",
  },
] as const;

/** A supported Free-plan quota with a fixed scope, unit and reset policy. */
export type HostingMeter = (typeof hostingMeters)[number];
/** Stable keys for the complete quota inventory, including unavailable meters. */
export type HostingMeterId = HostingMeter["id"];

/** Accepted Console surface for each meter that can be recorded on the Free plan. */
export const usageSources = {
  "cloudflare-requests": "cloudflare-account-console",
  "neon-compute": "neon-project-console",
  "neon-project-storage": "neon-project-console",
  "neon-organization-storage": "neon-organization-console",
} as const;

/** Meters with a supported provider evidence source in summary version 1. */
export type RecordedMeterId = keyof typeof usageSources;
/** The evidence surface for a meter, including the optional Neon project GET. */
type UsageSource = (typeof usageSources)[RecordedMeterId] | "neon-project-api";
/** Redacted collection outcomes that can be shown without raw provider details. */
export type UsageIssue =
  | "unavailable"
  | "refresh-failed"
  | "unsupported"
  | "scope"
  | "precision"
  | "period";

/** Maximum summary file length in bytes before the browser reads or parses it. */
export const usageFileLimit = 16_384;

/** Canonical UTC interval with an inclusive start and exclusive end. */
export interface UsagePeriod {
  start: string;
  end: string;
}

/** A numeric total or conservative upper bound with source, dates and scope. */
export interface UsageReading {
  value: number;
  precision: "exact" | "upper-bound";
  source: UsageSource;
  observedAt: string;
  dataThrough: string | null;
  period: UsagePeriod | null;
}

/** A validated reading or a fixed issue code for an attempted refresh. */
export type UsageOutcome = UsageReading | { issue: UsageIssue };
/** Sparse readings and failures. Omitted meters were outside the refresh. */
type Metrics = Partial<Record<RecordedMeterId, UsageOutcome>>;

/** Version 1 wire summary with a site origin and hashed provider target. */
export interface UsageSnapshot {
  version: 1;
  origin: string;
  target: string;
  generatedAt: string;
  metrics: Metrics;
}

/** Narrow a decoded object to named fields that callers still need to validate. */
export function usageRecord(input: unknown): Record<string, unknown> | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return null;
  }
  return input as Record<string, unknown>;
}

/** Permit only named properties from the versioned summary. */
function hasOnly(record: Record<string, unknown>, keys: readonly string[]) {
  return Object.keys(record).every((key) => keys.includes(key));
}

/** Require real, unambiguous UTC timestamps in a canonical wire format. */
export function usageTimestamp(input: unknown): input is string {
  if (
    typeof input !== "string" ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(input)
  ) {
    return false;
  }
  const epoch = Date.parse(input);
  return Number.isFinite(epoch) && new Date(epoch).toISOString() === input;
}

/** Accept a public HTTPS origin or the loopback preview origin. */
export function usageOrigin(input: unknown): input is string {
  if (typeof input !== "string" || input.length > 253) {
    return false;
  }
  try {
    const url = new URL(input);
    return (
      url.origin === input &&
      (url.protocol === "https:" ||
        (url.protocol === "http:" && url.hostname === "127.0.0.1"))
    );
  } catch {
    return false;
  }
}

/** Accept the canonical lowercase SHA-256 representation of a hosting target. */
export function usageTargetFingerprint(input: unknown): input is string {
  return (
    typeof input === "string" &&
    input.length === 64 &&
    /^[a-f0-9]{64}$/.test(input)
  );
}

/** Derive the exact quota window from the request observation's UTC day. */
export function requestsDay(observedAt: string): UsagePeriod {
  const start = `${observedAt.slice(0, 10)}T00:00:00.000Z`;
  return { start, end: new Date(Date.parse(start) + 86_400_000).toISOString() };
}

/** Verify that a billing or UTC window contains the reading and its provider timestamp. */
function readPeriod(
  input: unknown,
  meter: HostingMeter,
  observedAt: string,
  dataThrough: string | null,
): UsagePeriod | null {
  if (meter.period === "continuous" && input === null) {
    return null;
  }
  const period = usageRecord(input);
  if (
    !period ||
    !hasOnly(period, ["start", "end"]) ||
    !usageTimestamp(period.start) ||
    !usageTimestamp(period.end) ||
    period.start > observedAt ||
    observedAt >= period.end ||
    (dataThrough !== null && dataThrough < period.start) ||
    meter.period === "continuous"
  ) {
    throw Error();
  }
  if (meter.period === "utc-day") {
    const expected = requestsDay(observedAt);
    if (period.start !== expected.start || period.end !== expected.end) {
      throw Error();
    }
  }
  return { start: period.start, end: period.end };
}

/** Decode one provider reading against fixed metric provenance and numeric units. */
export function readUsageOutcome(
  id: RecordedMeterId,
  input: unknown,
  latest: string,
): UsageOutcome {
  const item = usageRecord(input);
  const meter = hostingMeters.find((entry) => entry.id === id);
  if (!item || !meter) {
    throw Error();
  }
  const { issue, source, value, precision, observedAt, dataThrough } = item;
  if (
    hasOnly(item, ["issue"]) &&
    (issue === "unavailable" ||
      issue === "refresh-failed" ||
      issue === "unsupported" ||
      issue === "scope" ||
      issue === "precision" ||
      issue === "period")
  ) {
    return { issue };
  }
  if (
    !hasOnly(item, [
      "source",
      "value",
      "precision",
      "observedAt",
      "dataThrough",
      "period",
    ]) ||
    (source !== usageSources[id] &&
      !(id === "neon-compute" && source === "neon-project-api")) ||
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > Number.MAX_SAFE_INTEGER ||
    (id === "cloudflare-requests" && !Number.isSafeInteger(value)) ||
    (precision !== "exact" &&
      (precision !== "upper-bound" || source === "neon-project-api")) ||
    !usageTimestamp(observedAt) ||
    observedAt > latest ||
    (dataThrough !== null &&
      (!usageTimestamp(dataThrough) || dataThrough > observedAt))
  ) {
    throw Error();
  }
  return {
    source: source === "neon-project-api" ? source : usageSources[id],
    value,
    precision,
    observedAt,
    dataThrough,
    period: readPeriod(item.period, meter, observedAt, dataThrough),
  };
}

/** Decode a summary for the given origin and validate its target fingerprint format. */
export function readUsageSnapshot(
  input: unknown,
  origin: string,
  now: number,
): UsageSnapshot {
  const snapshot = usageRecord(input);
  const metrics = usageRecord(snapshot?.metrics);
  if (
    !snapshot ||
    !metrics ||
    !hasOnly(snapshot, [
      "version",
      "origin",
      "target",
      "generatedAt",
      "metrics",
    ]) ||
    !hasOnly(metrics, Object.keys(usageSources)) ||
    snapshot.version !== 1 ||
    !usageOrigin(snapshot.origin) ||
    snapshot.origin !== origin ||
    !usageTargetFingerprint(snapshot.target) ||
    !usageTimestamp(snapshot.generatedAt) ||
    Date.parse(snapshot.generatedAt) > now
  ) {
    throw Error();
  }
  const clean: Metrics = {};
  for (const id of Object.keys(usageSources) as RecordedMeterId[]) {
    if (Object.hasOwn(metrics, id)) {
      clean[id] = readUsageOutcome(id, metrics[id], snapshot.generatedAt);
    }
  }
  return {
    version: 1,
    origin,
    target: snapshot.target,
    generatedAt: snapshot.generatedAt,
    metrics: clean,
  };
}
