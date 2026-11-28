import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import {
  DefaultRequestSigner,
  type RequestSigner,
  SimpleAuthenticationDetailsProvider,
} from "oci-common";
import {
  type MonthlyEvidence,
  missingMonthlyEvidence,
  type StorageCollector,
  type StorageEvidence,
  storageAllowance,
  usagePeriod,
} from "../../application/oci-storage/contract.ts";
import { boundedJson, untilAborted } from "../../http/bounded-json.ts";
import { monthlyUsageReport } from "./monthly-usage-report.ts";

/** The OCI connection is bound to the same tenancy and home region as the plan evidence. */
export interface StorageTarget {
  tenancy: string;
  region: string;
}

const hour = 3_600_000;
const day = 24 * hour;

/** Validate what OCI served independently of when that data may have been accounted. */
function responseTime(date: string | null, started: number, observed: number) {
  const responded = Date.parse(date ?? "");
  return Number.isFinite(responded) &&
    responded >= started - 30_000 &&
    responded <= observed &&
    new Date(responded).toUTCString() === date
    ? responded
    : null;
}

/** Validate and construct the restricted OCI signer without loading environment or files. */
export function storageEvidenceSigner(
  tenancy: string,
  user: string,
  pem: string,
  expectedFingerprint: string | undefined,
): RequestSigner {
  if (
    !/^ocid1\.user\.oc1\.\.[A-Za-z0-9]{1,128}$/.test(user) ||
    !pem ||
    pem.length > 8192
  )
    throw Error("OCI storage signing credentials unavailable");
  const key = createPrivateKey(pem);
  if (
    key.asymmetricKeyType !== "rsa" ||
    (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048
  )
    throw Error("OCI storage signing credentials unavailable");
  // OCI identifies the registered RSA key by its DER fingerprint.
  const fingerprint = createHash("md5")
    .update(createPublicKey(key).export({ type: "spki", format: "der" }))
    .digest("hex")
    .match(/../g)
    ?.join(":");
  if (!fingerprint || expectedFingerprint !== fingerprint)
    throw Error("OCI storage signing credentials unavailable");
  return new DefaultRequestSigner(
    new SimpleAuthenticationDetailsProvider(
      tenancy,
      user,
      fingerprint,
      pem,
      null,
    ),
  );
}

/** The limits value cannot establish account type. Require fresh Console evidence tied to the target. */
function eligibilityExpiry(
  value: unknown,
  target: StorageTarget,
  now: number,
): number {
  if (
    value === null ||
    typeof value !== "object" ||
    !("tenancy" in value) ||
    value.tenancy !== target.tenancy ||
    !("region" in value) ||
    value.region !== target.region ||
    !("plan" in value) ||
    value.plan !== "always-free-only" ||
    !("observedAt" in value) ||
    typeof value.observedAt !== "string"
  )
    return 0;
  const observed = Date.parse(value.observedAt);
  return Number.isFinite(observed) &&
    new Date(observed).toISOString() === value.observedAt &&
    observed <= now
    ? observed + 24 * hour
    : 0;
}

/** Read the provider's current quota usage as integer bytes, including a qualified explicit zero. */
function usedBytes(value: unknown): number | undefined {
  if (
    value === null ||
    typeof value !== "object" ||
    !("used" in value) ||
    typeof value.used !== "number" ||
    !Number.isSafeInteger(value.used) ||
    value.used < 0 ||
    !("available" in value) ||
    typeof value.available !== "number" ||
    !Number.isSafeInteger(value.available) ||
    value.available < 0 ||
    (value.used === 0 && value.available === 0)
  )
    return;
  return value.used;
}

/** A single ready home region allows its regional tenancy-root usage to cover this tenancy. */
function isSingleHomeRegion(value: unknown, region: string) {
  if (!Array.isArray(value) || value.length !== 1) return false;
  const entry: unknown = value[0];
  return (
    entry !== null &&
    typeof entry === "object" &&
    "regionName" in entry &&
    entry.regionName === region &&
    "isHomeRegion" in entry &&
    entry.isHomeRegion === true &&
    "status" in entry &&
    entry.status === "READY"
  );
}

/** Obtain independent storage and monthly outcomes under one deadline and the same OCI identity. */
export function ociStorageEvidence(
  target: StorageTarget,
  eligibility: unknown,
  signer: Pick<RequestSigner, "signHttpRequest">,
  send: typeof fetch = fetch,
  now: () => number = Date.now,
): StorageCollector {
  if (
    !/^ocid1\.tenancy\.oc1\.\.[A-Za-z0-9]{1,128}$/.test(target.tenancy) ||
    !/^[a-z]{2}-[a-z]+-[1-9][0-9]?$/.test(target.region)
  )
    throw Error("Invalid storage connection scope");
  const identity = `https://identity.${target.region}.oci.oraclecloud.com/20160918/tenancies/${target.tenancy}/regionSubscriptions`;
  const limits = new URL(
    `https://limits.${target.region}.oci.oraclecloud.com/20190729/services/object-storage/limits/storage-bytes/resourceAvailability`,
  );
  limits.searchParams.set("compartmentId", target.tenancy);

  const usage = `https://usageapi.${target.region}.oci.oraclecloud.com/20200107/usage?limit=${monthlyUsageReport.limit}`;

  /** Dispatch only the two fixed GETs or the fixed, read-only Usage API POST. */
  async function inspect(uri: string, signal: AbortSignal, body?: string) {
    const headers = new Headers();
    const request =
      body === undefined
        ? { uri, method: "GET" as const, headers }
        : { uri, method: "POST" as const, headers, body };
    await untilAborted(signal, () => signer.signHttpRequest(request));
    const response = await untilAborted(signal, () =>
      send(uri, {
        method: request.method,
        headers,
        ...(body === undefined ? {} : { body }),
        cache: "no-store",
        redirect: "error",
        signal,
      }),
    );
    if (response.status !== 200 || response.headers.has("opc-next-page")) {
      void response.body?.cancel().catch(() => {});
      if (response.status === 200 || response.status === 404)
        return { value: null, date: null };
      throw Error("OCI evidence unavailable");
    }
    return {
      value:
        body === undefined
          ? await boundedJson(response.body, signal, 8192)
          : await boundedJson(
              response.body,
              signal,
              256 * 1024,
              monthlyUsageReport.parse,
            ),
      date: response.headers.get("date"),
    };
  }

  /** Follow only the fixed home-region storage path after its local scope check. */
  async function storage(
    started: number,
    accountUntil: number,
    signal: AbortSignal,
  ): Promise<StorageEvidence> {
    let regionVerified = false;
    try {
      const regions = await inspect(identity, signal);
      if (!isSingleHomeRegion(regions.value, target.region))
        return { gap: "region-coverage-unverified", reading: null };
      regionVerified = true;
      const result = await inspect(limits.href, signal);
      const used = usedBytes(result.value);
      const observed = now();
      const responded = responseTime(result.date, started, observed);
      if (observed >= accountUntil)
        return { gap: "account-unverified", reading: null };
      if (used === undefined)
        return { gap: "storage-coverage-unverified", reading: null };
      if (responded === null)
        return { gap: "response-time-unverified", reading: null };
      return {
        // The date establishes response time. Limits supplies no accounting watermark.
        gap: "accounting-cutoff-unverified",
        reading: {
          usedBytes: used,
          limitBytes: storageAllowance,
          source: "OCI",
          respondedAt: new Date(responded).toISOString(),
          accountingCutoff: null,
          observedAt: new Date(observed).toISOString(),
          expiresAt: new Date(
            Math.min(responded + 2 * hour, accountUntil),
          ).toISOString(),
        },
      };
    } catch {
      return {
        gap: regionVerified ? "oci-unavailable" : "region-coverage-unverified",
        reading: null,
      };
    }
  }

  /** Ask for elapsed UTC days only. The interval and familiar SKU do not certify completeness. */
  async function monthly(
    started: number,
    accountUntil: number,
    signal: AbortSignal,
  ): Promise<MonthlyEvidence> {
    const period = usagePeriod(started);
    const start = Date.parse(period.periodStart);
    const end = Date.parse(period.periodEnd);
    const through = Math.floor(started / day) * day;
    if (start >= through)
      return missingMonthlyEvidence("usage-coverage-unverified");
    try {
      const result = await inspect(
        usage,
        signal,
        JSON.stringify({
          tenantId: target.tenancy,
          timeUsageStarted: period.periodStart,
          timeUsageEnded: new Date(through).toISOString(),
          granularity: "DAILY",
          queryType: "USAGE_ONLY",
          isAggregateByTime: false,
          groupBy: ["skuPartNumber", "unit"],
          filter: {
            operator: "OR",
            dimensions: monthlyUsageReport.skus.map((value) => ({
              key: "skuPartNumber",
              value,
            })),
          },
        }),
      );
      const observed = now();
      const responded = responseTime(result.date, started, observed);
      if (observed >= accountUntil)
        return missingMonthlyEvidence("account-unverified");
      if (observed >= end || result.value === null)
        return missingMonthlyEvidence("usage-coverage-unverified");
      if (responded === null || responded < through)
        return missingMonthlyEvidence("response-time-unverified");
      return monthlyUsageReport.project(result.value, through, {
        ...period,
        respondedAt: new Date(responded).toISOString(),
        observedAt: new Date(observed).toISOString(),
        expiresAt: new Date(
          Math.min(responded + 2 * hour, accountUntil, end),
        ).toISOString(),
      });
    } catch {
      return missingMonthlyEvidence("oci-unavailable");
    }
  }

  return async (): Promise<StorageEvidence> => {
    const started = now();
    const accountUntil = eligibilityExpiry(eligibility, target, started);
    if (started >= accountUntil)
      return {
        gap: "account-unverified",
        reading: null,
        monthly: missingMonthlyEvidence("account-unverified"),
      };
    const signal = AbortSignal.timeout(4000);
    const [storageResult, monthlyResult] = await Promise.all([
      storage(started, accountUntil, signal),
      monthly(started, accountUntil, signal),
    ]);
    return { ...storageResult, monthly: monthlyResult };
  };
}
