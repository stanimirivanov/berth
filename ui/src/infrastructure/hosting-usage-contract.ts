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

export type HostingMeter = (typeof hostingMeters)[number];
export type HostingMeterId = HostingMeter["id"];

export const usageSources = {
  "cloudflare-requests": "cloudflare-account-console",
  "neon-compute": "neon-project-console",
  "neon-project-storage": "neon-project-console",
  "neon-organization-storage": "neon-organization-console",
} as const;

export type RecordedMeterId = keyof typeof usageSources;
type UsageSource = (typeof usageSources)[RecordedMeterId] | "neon-project-api";
export type UsageIssue =
  | "unavailable"
  | "refresh-failed"
  | "unsupported"
  | "scope"
  | "precision"
  | "period";

export const usageFileLimit = 16_384;
export const usageFreshness = 2 * 60 * 60 * 1000;

export interface UsagePeriod {
  start: string;
  end: string;
}

export interface UsageReading {
  value: number;
  precision: "exact" | "upper-bound";
  source: UsageSource;
  observedAt: string;
  dataThrough: string | null;
  period: UsagePeriod | null;
}

export type UsageOutcome = UsageReading | { issue: UsageIssue };
type Metrics = Partial<Record<RecordedMeterId, UsageOutcome>>;

export interface UsageSnapshot {
  version: 1;
  origin: string;
  target: string;
  generatedAt: string;
  metrics: Metrics;
}

interface RetainedReading {
  reading: UsageReading | null;
  issue: UsageIssue | null;
}

export interface UsageState extends Omit<UsageSnapshot, "metrics"> {
  metrics: Partial<Record<RecordedMeterId, RetainedReading>>;
}

/** Inspect parsed input without accepting arrays, primitives or arbitrary fields. */
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

/** Validate a bounded import's version, site, target, timestamp and allowed readings. */
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
    typeof snapshot.target !== "string" ||
    !/^[a-f0-9]{64}$/.test(snapshot.target) ||
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

/** Preserve valid readings when a refresh fails or supplies conflicting evidence. */
export function applyUsageSnapshot(
  previous: UsageState | null,
  snapshot: UsageSnapshot,
): UsageState {
  if (
    previous &&
    (previous.origin !== snapshot.origin ||
      previous.target !== snapshot.target ||
      previous.generatedAt > snapshot.generatedAt)
  ) {
    throw Error();
  }

  const metrics = { ...previous?.metrics };
  for (const id of Object.keys(usageSources) as RecordedMeterId[]) {
    const outcome = snapshot.metrics[id];
    if (!outcome) {
      continue;
    }
    const earlier = metrics[id]?.reading ?? null;
    if ("issue" in outcome) {
      metrics[id] = { reading: earlier, issue: outcome.issue };
      continue;
    }
    if (earlier && outcome.observedAt < earlier.observedAt) {
      continue;
    }
    if (
      earlier?.period &&
      outcome.period &&
      (outcome.period.start < earlier.period.start ||
        (outcome.period.start < earlier.period.end &&
          (outcome.period.start !== earlier.period.start ||
            outcome.period.end !== earlier.period.end)))
    ) {
      metrics[id] = { reading: earlier, issue: "period" };
      continue;
    }
    metrics[id] = { reading: outcome, issue: null };
  }

  return { ...snapshot, metrics };
}

const issueText: Record<UsageIssue, string> = {
  unavailable: "There is no qualifying reading yet.",
  "refresh-failed": "The last refresh failed.",
  unsupported:
    "Neon did not return a supported compute total. Record a project Console reading when available.",
  scope: "The evidence does not match the required target or scope.",
  precision:
    "The reported unit or precision does not establish usage or a defensible upper bound.",
  period: "The evidence does not match the applicable quota period.",
};

/** An unreadable refresh makes previously retained readings stale until each recovers. */
export function failedUsageImport(state: UsageState | null): UsageState | null {
  if (!state) {
    return null;
  }
  const metrics = { ...state.metrics };
  for (const id of Object.keys(usageSources) as RecordedMeterId[]) {
    const held = metrics[id];
    if (held?.reading) {
      metrics[id] = { reading: held.reading, issue: "refresh-failed" };
    }
  }
  return { ...state, metrics };
}

/** Explain why a meter with no accepted Free source remains unknown. */
function noReading(meter: HostingMeter): string {
  if (meter.id === "neon-transfer") {
    return "Available sources do not establish the project total across Postgres, Object Storage and Functions.";
  }
  if (meter.service === "Neon Functions") {
    return "The verified Free sources do not provide project billing-period totals.";
  }
  return issueText.unavailable;
}

/** Find the first millisecond at which this reading will cease to be current. */
export function usageExpiresAt(reading: UsageReading): number {
  const ageLimit =
    Date.parse(reading.dataThrough ?? reading.observedAt) + usageFreshness + 1;
  return reading.period
    ? Math.min(ageLimit, Date.parse(reading.period.end))
    : ageLimit;
}

/** Derive current headroom and advisory warnings only from qualified readings. */
export function hostingUsageRows(state: UsageState | null, now: number) {
  return hostingMeters.map((meter) => {
    const retained = (
      state?.metrics as
        | Partial<Record<HostingMeterId, RetainedReading>>
        | undefined
    )?.[meter.id];
    const reading = retained?.reading ?? null;
    const issue = retained?.issue;
    const row = { ...meter, reading, remaining: null, warning: null };
    if (!reading) {
      return {
        ...row,
        status: "Unknown",
        reason: issue ? issueText[issue] : noReading(meter),
      };
    }
    if (issue) {
      return { ...row, status: "Stale", reason: issueText[issue] };
    }
    if (reading.period && now >= Date.parse(reading.period.end)) {
      return { ...row, status: "Stale", reason: "The quota period has ended." };
    }
    if (now >= usageExpiresAt(reading)) {
      return {
        ...row,
        status: "Stale",
        reason: "The reading is more than two hours old.",
      };
    }
    const warning =
      reading.value >= meter.limit
        ? "Limit reached"
        : reading.value >= meter.limit * 0.95
          ? "Near limit"
          : reading.value >= meter.limit * 0.8
            ? "Approaching limit"
            : null;
    return {
      ...row,
      status: "Current",
      reason: null,
      remaining: Math.max(0, meter.limit - reading.value),
      warning,
    };
  });
}

export type HostingUsageRow = ReturnType<typeof hostingUsageRows>[number];
