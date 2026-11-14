import type { RequestSigner } from "oci-common";
/** Closed metric vocabulary: operational bucket coverage only, never billing. */
export const metricNames = [
  "StoredBytes",
  "ObjectCount",
  "AllRequests",
] as const;
/** One allowed OCI Object Storage metric. */
export type MetricName = (typeof metricNames)[number];
/** Persisted ownership and verified upload time, never taken from an HTTP caller. */
export interface UsageTarget {
  bucketId: string;
  bucket: string;
  compartment: string;
  uploadedAt: number;
}
/** Explicit unknown values cannot be mistaken for a measured zero. */
export interface MetricObservation {
  metric: MetricName;
  status: "known" | "unknown";
  value: number | null;
  sourceAt: string | null;
  observedAt: string;
}
/** Fixed one-hour windows; gauges use maxima, request counts use interval sums. */
export function usageQuery(
  metric: MetricName,
  target: UsageTarget,
  now: number,
) {
  if (
    !metricNames.includes(metric) ||
    !/^ocid1\.bucket\.[A-Za-z0-9._-]{1,200}$/.test(target.bucketId) ||
    !Number.isFinite(target.uploadedAt) ||
    !Number.isFinite(now) ||
    now < target.uploadedAt ||
    now - target.uploadedAt > 14400000
  )
    throw Error("Invalid metric target");
  return {
    namespace: "oci_objectstorage",
    query: `${metric}[1h]{resourceID = "${target.bucketId}"}.groupBy(resourceID, resourceDisplayName${metric === "AllRequests" ? "" : ", tier"}).${metric === "AllRequests" ? "sum" : "max"}()`,
    startTime: new Date(target.uploadedAt).toISOString(),
    endTime: new Date(now).toISOString(),
    resolution: "1h",
  };
}
/** Validate provider data before persistence; never sum tiers or adopt a similarly named bucket. */
export function readMetric(
  metric: MetricName,
  raw: unknown,
  target: UsageTarget,
  now: number,
): MetricObservation {
  const unknown: MetricObservation = {
    metric,
    status: "unknown",
    value: null,
    sourceAt: null,
    observedAt: new Date(now).toISOString(),
  };
  if (!Array.isArray(raw) || raw.length !== 1) return unknown;
  const s = raw[0];
  if (
    s?.namespace !== "oci_objectstorage" ||
    s.name !== metric ||
    s.compartmentId !== target.compartment ||
    s.dimensions?.resourceID !== target.bucketId ||
    s.dimensions?.resourceDisplayName !== target.bucket ||
    (metric !== "AllRequests" &&
      (typeof s.dimensions?.tier !== "string" ||
        s.dimensions.tier.toLowerCase() !== "standard")) ||
    (metric === "AllRequests" && s.dimensions?.tier !== undefined) ||
    !Array.isArray(s.aggregatedDatapoints) ||
    s.aggregatedDatapoints.length > 8
  )
    return unknown;
  const points: { value: number; at: number }[] = [];
  for (const p of s.aggregatedDatapoints) {
    const at = typeof p?.timestamp === "string" ? Date.parse(p.timestamp) : NaN;
    if (
      !Number.isFinite(at) ||
      typeof p?.value !== "number" ||
      !Number.isFinite(p.value) ||
      p.value < 0
    )
      return unknown;
    if (at - 3600000 >= target.uploadedAt && at <= now && now - at <= 5400000)
      points.push({ value: p.value, at });
  }
  points.sort((a, b) => b.at - a.at);
  const latest = points[0];
  if (!latest || points.some((p, i) => i > 0 && p.at === latest.at))
    return unknown;
  return {
    ...unknown,
    status: "known",
    value: latest.value,
    sourceAt: new Date(latest.at).toISOString(),
  };
}
/** One underlying request per invocation; caller must reserve Monitoring allowance before calling. */
export type UsageTransport = (
  query: ReturnType<typeof usageQuery>,
  signal: AbortSignal,
) => Promise<unknown>;
/** Signed bounded REST transport avoids SDK retries; target and credentials are injected server-side. */
export function monitoringTransport(
  region: string,
  compartment: string,
  signer: RequestSigner,
  fetcher: typeof fetch = fetch,
): UsageTransport {
  if (
    !/^[a-z]{2}-[a-z]+-[1-9]$/.test(region) ||
    !/^ocid1\.compartment\.[A-Za-z0-9._-]{1,200}$/.test(compartment)
  )
    throw Error("Invalid monitoring target");
  const uri = `https://telemetry.${region}.oraclecloud.com/20180401/metrics/actions/summarizeMetricsData?${new URLSearchParams({ compartmentId: compartment })}`;
  return async (query, execution) => {
    const signal = AbortSignal.any([execution, AbortSignal.timeout(5000)]);
    const request = {
      uri,
      method: "POST" as const,
      headers: new Headers({ "content-type": "application/json" }),
      body: JSON.stringify(query),
    };
    signal.throwIfAborted();
    await signer.signHttpRequest(request);
    signal.throwIfAborted();
    const response = await fetcher(uri, {
      method: "POST" as const,
      headers: request.headers,
      body: request.body,
      redirect: "error",
      signal,
    });
    const reader = response.body?.getReader();
    try {
      if (!response.ok || response.headers.get("opc-next-page") || !reader)
        throw Error();
      let text = "",
        bytes = 0;
      const decoder = new TextDecoder("utf-8", { fatal: true });
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.length;
        if (bytes > 65536) throw Error();
        text += decoder.decode(chunk.value, { stream: true });
      }
      return JSON.parse(text + decoder.decode());
    } catch {
      throw Error("Monitoring response unavailable");
    } finally {
      await reader?.cancel().catch(() => undefined);
      reader?.releaseLock();
    }
  };
}
