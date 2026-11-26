import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import type {
  RecordedMeterId,
  UsageOutcome,
  UsageSnapshot,
} from "../ui/src/infrastructure/hosting-usage-contract.ts";
import {
  hostingMeters,
  readUsageOutcome,
  readUsageSnapshot,
  requestsDay,
  usageOrigin,
  usageRecord,
  usageSources,
  usageTimestamp,
} from "../ui/src/infrastructure/hosting-usage-contract.ts";
import { readPrivateText } from "./oci-files.ts";

interface UsageTarget {
  cloudflareAccount: string;
  neonOrganization: string;
  neonProject: string;
}

interface Collector {
  clock: () => number;
  neonKey: string | null;
  send: typeof fetch;
}

const providerBodyLimit = 65_536;
const targetKey = /^[a-z0-9][a-z0-9_-]{0,127}$/;

const targetFor = {
  "cloudflare-requests": "cloudflareAccount",
  "neon-compute": "neonProject",
  "neon-project-storage": "neonProject",
  "neon-organization-storage": "neonOrganization",
} as const;

/** Verify the owner's expected deployment and meter inventory before sending. */
function collectorInput(input: unknown) {
  const file = usageRecord(input);
  const target = usageRecord(file?.target);
  const metrics = usageRecord(file?.metrics);
  if (
    !file ||
    !usageOrigin(file.origin) ||
    !target ||
    !metrics ||
    Object.keys(file).some(
      (key) => !["origin", "target", "metrics"].includes(key),
    ) ||
    Object.keys(target).length !== 3 ||
    Object.keys(metrics).some((id) => !Object.hasOwn(usageSources, id))
  ) {
    throw Error();
  }
  const { cloudflareAccount, neonOrganization, neonProject } = target;
  for (const id of [cloudflareAccount, neonOrganization, neonProject]) {
    if (typeof id !== "string" || !targetKey.test(id)) {
      throw Error();
    }
  }
  return {
    origin: file.origin,
    target: { cloudflareAccount, neonOrganization, neonProject } as UsageTarget,
    metrics,
  };
}

/** Match the original Console surface and require explicit, compatible precision. */
function consoleReading(
  id: RecordedMeterId,
  input: unknown,
  target: UsageTarget,
  latest: string,
): UsageOutcome {
  const reading = usageRecord(input);
  const meter = hostingMeters.find((entry) => entry.id === id);
  if (input === null) {
    return { issue: "unavailable" };
  }
  if (
    !meter ||
    !reading ||
    reading.source !== usageSources[id] ||
    reading.target !== target[targetFor[id]]
  ) {
    return { issue: "scope" };
  }
  const { unit, value, precision, observedAt } = reading;
  if (
    unit !== meter.unit ||
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > Number.MAX_SAFE_INTEGER ||
    (id === "cloudflare-requests" && !Number.isSafeInteger(value)) ||
    (precision !== "exact" && precision !== "upper-bound")
  ) {
    return { issue: "precision" };
  }
  if (!usageTimestamp(observedAt)) {
    return { issue: "period" };
  }
  try {
    return readUsageOutcome(
      id,
      {
        source: reading.source,
        observedAt,
        precision,
        value,
        dataThrough: reading.dataThrough ?? null,
        period:
          id === "cloudflare-requests"
            ? (reading.period ?? requestsDay(observedAt))
            : (reading.period ?? null),
      },
      latest,
    );
  } catch {
    return { issue: "period" };
  }
}

/** Read a small provider response without following pagination or retaining raw data. */
async function readProject(response: Response): Promise<unknown> {
  if (!response.ok || !response.body) {
    void response.body?.cancel().catch(() => {});
    throw Error();
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      size += value.byteLength;
      if (size > providerBodyLimit) {
        void reader.cancel().catch(() => {});
        throw Error();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
  );
}

/** Normalize provider UTC timestamps without guessing a date or billing period. */
function providerTimestamp(value: unknown) {
  if (typeof value !== "string") {
    return null;
  }
  const match =
    /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?(?:Z|\+00:00)$/.exec(
      value,
    );
  if (!match) {
    return null;
  }
  const canonical = `${match[1]}.${(match[2] ?? "").padEnd(3, "0").slice(0, 3)}Z`;
  return usageTimestamp(canonical) ? canonical : null;
}

/** Collect one project-scoped compute reading from the Free management surface. */
async function neonReading(
  target: UsageTarget,
  { clock, neonKey, send }: Collector,
): Promise<UsageOutcome> {
  if (!neonKey || !/^[A-Za-z0-9_.~+/=-]{16,512}$/.test(neonKey)) {
    return { issue: "refresh-failed" };
  }
  let body: unknown;
  try {
    body = await readProject(
      await send(
        `https://console.neon.tech/api/v2/projects/${target.neonProject}`,
        {
          method: "GET",
          headers: {
            accept: "application/json",
            authorization: `Bearer ${neonKey}`,
          },
          redirect: "error",
          cache: "no-store",
          signal: AbortSignal.timeout(5_000),
        },
      ),
    );
  } catch {
    return { issue: "refresh-failed" };
  }

  const project = usageRecord(usageRecord(body)?.project);
  if (!project) {
    return { issue: "unsupported" };
  }
  if (
    project.id !== target.neonProject ||
    (project.org_id ?? project.owner_id) !== target.neonOrganization
  ) {
    return { issue: "scope" };
  }
  // Neon documents compute_time_seconds on the Free project snapshot as weighted CU-seconds.
  const legacy = project.compute_time_seconds;
  const weighted = project.compute_unit_seconds;
  const seconds = weighted ?? legacy;
  if (
    typeof seconds !== "number" ||
    !Number.isSafeInteger(seconds) ||
    seconds < 0 ||
    (weighted !== undefined && legacy !== undefined && weighted !== legacy)
  ) {
    return { issue: "unsupported" };
  }
  const start = providerTimestamp(project.consumption_period_start);
  const end = providerTimestamp(project.consumption_period_end);
  const observedAt = new Date(clock()).toISOString();
  try {
    return readUsageOutcome(
      "neon-compute",
      {
        source: "neon-project-api",
        precision: "exact",
        value: seconds / 3600,
        observedAt,
        dataThrough: null,
        period: { start, end },
      },
      observedAt,
    );
  } catch {
    return { issue: "period" };
  }
}

/** Return only validated readings and fixed issue codes for the supplied deployment. */
export async function collectHostingUsage(
  input: unknown,
  collector: Collector,
): Promise<UsageSnapshot> {
  const { origin, target, metrics } = collectorInput(input);
  const generatedAt = new Date(collector.clock()).toISOString();
  const results: UsageSnapshot["metrics"] = {};
  for (const id of Object.keys(usageSources) as RecordedMeterId[]) {
    if (Object.hasOwn(metrics, id)) {
      results[id] = consoleReading(id, metrics[id], target, generatedAt);
    }
  }
  if (collector.neonKey !== null) {
    const computed = await neonReading(target, collector);
    const ownerReading = results["neon-compute"];
    if (!("issue" in computed) || !ownerReading || "issue" in ownerReading) {
      results["neon-compute"] = computed;
    }
  }
  // Hash the canonical target only. Provider IDs and credentials remain in operator files.
  const fingerprint = createHash("sha256")
    .update(JSON.stringify(target))
    .digest("hex");
  const finishedAt = collector.clock();
  return readUsageSnapshot(
    {
      version: 1,
      origin,
      target: fingerprint,
      generatedAt: new Date(finishedAt).toISOString(),
      metrics: results,
    },
    origin,
    finishedAt,
  );
}

/** Read owner-only local inputs and emit the bounded browser import format. */
async function run() {
  const { values } = parseArgs({
    options: {
      "input-file": { type: "string" },
      "neon-key-file": { type: "string" },
    },
  });
  if (!values["input-file"]) {
    throw Error();
  }
  const input: unknown = JSON.parse(
    await readPrivateText(values["input-file"]),
  );
  const neonKey = values["neon-key-file"]
    ? (await readPrivateText(values["neon-key-file"]).catch(() => "")).trim()
    : null;
  const snapshot = await collectHostingUsage(input, {
    clock: Date.now,
    neonKey,
    send: fetch,
  });
  process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
}

if (import.meta.main) {
  await run().catch(() => {
    console.error(
      "Usage refresh could not read or validate the owner input. Check the owner-only files and the usage runbook.",
    );
    process.exitCode = 1;
  });
}
