import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import {
  DefaultRequestSigner,
  type RequestSigner,
  SimpleAuthenticationDetailsProvider,
} from "oci-common";
import {
  type StorageCollector,
  type StorageEvidence,
  storageAllowance,
} from "../../application/oci-storage/contract.ts";
import { boundedJson, untilAborted } from "../../http/bounded-json.ts";

/** The OCI connection is bound to the same tenancy and home region as the plan evidence. */
export interface StorageTarget {
  tenancy: string;
  region: string;
}

const hour = 3_600_000;

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

/** Obtain at most two signed GETs in one deadline. An incomplete regional scope stays unknown. */
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

  /** Only fixed-endpoint JSON GETs can enter the signed transport. */
  async function inspect(uri: string, signal: AbortSignal) {
    const request = { uri, method: "GET" as const, headers: new Headers() };
    await untilAborted(signal, () => signer.signHttpRequest(request));
    const response = await untilAborted(signal, () =>
      send(uri, {
        method: request.method,
        headers: request.headers,
        cache: "no-store",
        redirect: "error",
        signal,
      }),
    );
    if (response.status !== 200 || response.headers.get("opc-next-page")) {
      void response.body?.cancel().catch(() => {});
      if (response.status === 200 || response.status === 404)
        return { value: null, date: null };
      throw Error("OCI evidence unavailable");
    }
    return {
      value: await boundedJson(response.body, signal, 8192),
      date: response.headers.get("date"),
    };
  }

  return async (): Promise<StorageEvidence> => {
    const started = now();
    const accountUntil = eligibilityExpiry(eligibility, target, started);
    if (started >= accountUntil)
      return { gap: "account-unverified", reading: null };
    const signal = AbortSignal.timeout(4000);
    let regionVerified = false;
    try {
      const regions = await inspect(identity, signal);
      if (!isSingleHomeRegion(regions.value, target.region))
        return { gap: "region-coverage-unverified", reading: null };
      regionVerified = true;
      const result = await inspect(limits.href, signal);
      const used = usedBytes(result.value);
      const cutoff = Date.parse(result.date ?? "");
      const observed = now();
      if (observed >= accountUntil)
        return { gap: "account-unverified", reading: null };
      if (used === undefined)
        return { gap: "storage-coverage-unverified", reading: null };
      if (
        !Number.isFinite(cutoff) ||
        cutoff < started - 30_000 ||
        cutoff > observed
      )
        return { gap: "response-time-unverified", reading: null };
      return {
        // The date establishes response time. Limits supplies no accounting watermark.
        gap: "accounting-cutoff-unverified",
        reading: {
          usedBytes: used,
          limitBytes: storageAllowance,
          source: "OCI",
          respondedAt: new Date(cutoff).toISOString(),
          accountingCutoff: null,
          observedAt: new Date(observed).toISOString(),
          expiresAt: new Date(
            Math.min(cutoff + 2 * hour, accountUntil),
          ).toISOString(),
        },
      };
    } catch {
      return {
        gap: regionVerified ? "oci-unavailable" : "region-coverage-unverified",
        reading: null,
      };
    }
  };
}
