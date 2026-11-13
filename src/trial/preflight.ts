/** Fixed server target and separately metered service limits; no caller overrides. */
export interface TrialConfiguration {
  compartment: string;
  namespace: string;
  region: string;
  monitoringLimit: number;
  neonLimit: number;
}
/** Owner aggregate attestation, not a provider billing API or hard spending guarantee. */
export interface Headroom {
  checkedAt: number;
  accountType: string;
  homeRegion: string;
  storageBytes: number;
  objectRequests: number;
  transferBytes: number;
  monitoringRequests: number;
  neonFree: boolean;
  neonInvocations: number;
  neonComputeSeconds: number;
  measuredComputeSeconds: number;
}
/** Fail closed on unsupported target/configuration before admission can be constructed. */
export function validateConfiguration(c: TrialConfiguration) {
  if (
    Object.keys(c).sort().join(",") !==
      "compartment,monitoringLimit,namespace,neonLimit,region" ||
    !/^ocid1[.]compartment[.]oc1[.][.][A-Za-z0-9]{1,128}$/.test(
      c.compartment,
    ) ||
    !/^[A-Za-z0-9_-]{1,64}$/.test(c.namespace) ||
    !/^[a-z]{2}-[a-z]+-[1-9]$/.test(c.region) ||
    ![c.monitoringLimit, c.neonLimit].every(
      (n) => Number.isInteger(n) && n >= 1 && n <= 1000,
    )
  )
    throw Error("Invalid trial configuration");
}
/** Pure creation gate. Cleanup deliberately does not call this gate. Values are never echoed. */
export function preflight(
  c: TrialConfiguration,
  input: unknown,
  now: number,
): string[] {
  validateConfiguration(c);
  if (!input || typeof input !== "object" || !Number.isFinite(now))
    return ["headroom-unknown"];
  const e = input as Partial<Headroom>;
  if (
    typeof e.checkedAt !== "number" ||
    !Number.isFinite(e.checkedAt) ||
    e.checkedAt > now ||
    now - e.checkedAt > 86400000
  )
    return ["headroom-stale-or-unknown"];
  if (
    !["always-free", "free-trial"].includes(e.accountType ?? "") ||
    e.homeRegion !== c.region ||
    e.neonFree !== true
  )
    return ["eligibility-unverified"];
  const sufficient = (value: unknown, minimum: number) =>
    typeof value === "number" && Number.isFinite(value) && value >= minimum;
  if (
    !sufficient(e.storageBytes, 10485760) ||
    !sufficient(e.objectRequests, 200) ||
    !sufficient(e.transferBytes, 1048576) ||
    !sufficient(e.monitoringRequests, c.monitoringLimit) ||
    !sufficient(e.neonInvocations, c.neonLimit) ||
    !sufficient(e.measuredComputeSeconds, Number.MIN_VALUE) ||
    !sufficient(e.neonComputeSeconds, e.measuredComputeSeconds ?? Infinity)
  )
    return ["headroom-insufficient-or-unmeasured"];
  return [];
}
/** Shared runtime/deployment projection of the authoritative ledger's four-hour window. */
export function trialWindow(started: string, expires: string) {
  const start = Date.parse(started),
    end = Date.parse(expires);
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    end - start !== 14400000
  )
    throw Error("Invalid trial window");
  return {
    startedAt: new Date(start).toISOString(),
    runtimeExpiresAt: new Date(end).toISOString(),
    deploymentExpiresAt: new Date(end).toISOString(),
  };
}
/** Exact non-secret proposal; markers are generated atomically by the ledger on submission. */
export function proposal(c: TrialConfiguration, operation: string) {
  return {
    target: {
      compartment: c.compartment,
      namespace: c.namespace,
      region: c.region,
    },
    bucket: {
      name: `berth-${operation.replaceAll("-", "")}`,
      publicAccessType: "NoPublicAccess",
      storageTier: "Standard",
      versioning: "Disabled",
      autoTiering: "Disabled",
      objectEventsEnabled: false,
      encryption: "Oracle-managed",
      retention: false,
      replication: false,
      ownershipMarker: "ledger-generated",
    },
    object: {
      name: "trial.bin",
      bytes: 1048576,
      sha256:
        "fbbab289f7f94b25736c58be46a994c441fd02552cc6022352e3d86d2fab7c83",
      createOnly: true,
    },
    budgets: {
      normalRequests: 160,
      cleanupRequests: 40,
      monitoringRequests: c.monitoringLimit,
      neonInvocations: c.neonLimit,
    },
    durationSeconds: 14400,
  };
}
