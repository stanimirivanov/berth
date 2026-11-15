/** Fixed server target and separately metered service limits; no caller overrides. */
export interface TrialConfiguration {
  compartment: string;
  namespace: string;
  region: string;
  monitoringLimit: number;
  neonLimit: number;
}
/** Immutable owner-prepared live identity; callers cannot select a different trial. */
export interface PreparedTrial {
  operation: string;
  startedAt: number;
  expiresAt: number;
}
/** Explicit one-use exception commitments; remaining Functions quota is deliberately absent. */
export interface FunctionsException extends PreparedTrial {
  unknownAllowanceAccepted: true;
  partialVerdictAccepted: true;
  exclusiveProjectUse: true;
  manualRecoveryReady: true;
  otherServicesEvidence: string;
  shutdownBy: number;
  probeClientMs: number;
  scenario: "64x60-plus36x60-v1";
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
  functionsMode?: "verified" | "free-functions-one-trial";
  functionsException?: FunctionsException;
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
  prepared?: PreparedTrial,
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
    !sufficient(e.monitoringRequests, c.monitoringLimit)
  )
    return ["headroom-insufficient-or-unmeasured"];
  if (e.functionsMode === "free-functions-one-trial")
    return validFunctionsException(c, e, now, prepared)
      ? []
      : ["functions-exception-invalid"];
  if (
    (e.functionsMode !== undefined && e.functionsMode !== "verified") ||
    e.functionsException !== undefined
  )
    return ["functions-mode-invalid"];
  if (
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

/** Reject partial or mixed exception evidence; SQL independently owns single-use enforcement. */
function validFunctionsException(
  c: TrialConfiguration,
  e: Partial<Headroom>,
  now: number,
  p?: PreparedTrial,
) {
  const x = e.functionsException;
  return !!(
    p &&
    x &&
    c.neonLimit === 64 &&
    ["neonInvocations", "neonComputeSeconds", "measuredComputeSeconds"].every(
      (key) => !(key in e),
    ) &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
      p.operation,
    ) &&
    Number.isSafeInteger(p.startedAt) &&
    Number.isSafeInteger(p.expiresAt) &&
    p.expiresAt - p.startedAt === 14400000 &&
    now >= p.startedAt &&
    now < p.startedAt + 300000 &&
    x.operation === p.operation &&
    x.startedAt === p.startedAt &&
    x.expiresAt === p.expiresAt &&
    (e.checkedAt ?? 0) + 86400000 >= p.startedAt + 1800000 &&
    x.unknownAllowanceAccepted === true &&
    x.partialVerdictAccepted === true &&
    x.exclusiveProjectUse === true &&
    x.manualRecoveryReady === true &&
    typeof x.otherServicesEvidence === "string" &&
    /^[A-Za-z0-9_-]{1,80}$/.test(x.otherServicesEvidence) &&
    x.shutdownBy === p.expiresAt + 900000 &&
    x.scenario === "64x60-plus36x60-v1" &&
    typeof x.probeClientMs === "number" &&
    Number.isFinite(x.probeClientMs) &&
    x.probeClientMs > 0 &&
    x.probeClientMs <= 3000
  );
}

/** Separate lifecycle success from the exception's mandatory partial feasibility ceiling. */
export function functionsAssessment(evidence: unknown) {
  const e = evidence as Partial<Headroom> | null;
  return e?.functionsMode === "free-functions-one-trial"
    ? {
        mode: "free-functions-one-trial",
        verdict: "partial",
        functionsAllowance: "unknown",
        hardSpendingCap: false,
        scenario: "64x60-plus36x60-v1",
        scenarioCapacitySeconds: 6000,
        scenarioInvocations: 100,
        shutdownBy: e.functionsException?.shutdownBy,
      }
    : undefined;
}
