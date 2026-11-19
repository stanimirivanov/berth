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
/** Separately reviewed Free-plan operation; provider totals remain unknown, not zero. */
export interface FunctionsPolicy extends FunctionsException {
  policyVersion: "free-plan-v1";
  reviewer: string;
  plan: {
    status: "free";
    source: "owner-console" | "provider-api";
    checkedAt: number;
    project: string;
    branch: string;
    period: string;
    evidence: string;
  };
  billing: {
    reviewedAt: number;
    source: "neon-free-no-overage-2026-11-19";
    evidence: string;
  };
  allowances: {
    postgresStorageBytes: number;
    requiredPostgresStorageBytes: number;
    postgresComputeCuSeconds: number;
    requiredPostgresComputeCuSeconds: number;
    sharedTransferBytes: number;
    requiredSharedTransferBytes: number;
  };
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
  /** Required only by verified mode; unknown-allowance modes reject these keys. */
  neonInvocations?: number;
  neonComputeSeconds?: number;
  measuredComputeSeconds?: number;
  functionsMode?:
    | "verified"
    | "free-functions-one-trial"
    | "free-plan-unknown-v1";
  functionsException?: FunctionsException;
  functionsPolicy?: FunctionsPolicy;
  functionsUsage?: "unknown";
  functionsAllowance?: "unknown";
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
  if (e.functionsMode === "free-plan-unknown-v1")
    return validFunctionsPolicy(c, e, now, prepared)
      ? []
      : ["functions-policy-invalid"];
  if (
    (e.functionsMode !== undefined && e.functionsMode !== "verified") ||
    e.functionsException !== undefined ||
    e.functionsPolicy !== undefined ||
    e.functionsUsage !== undefined ||
    e.functionsAllowance !== undefined
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

/** Validate the new evidence contract; reusing commitment checks never reuses the old SQL slot. */
function validFunctionsPolicy(
  c: TrialConfiguration,
  e: Partial<Headroom>,
  now: number,
  p?: PreparedTrial,
) {
  const x = e.functionsPolicy;
  if (
    !x ||
    e.functionsException !== undefined ||
    e.functionsUsage !== "unknown" ||
    e.functionsAllowance !== "unknown" ||
    !validFunctionsException(c, { ...e, functionsException: x }, now, p)
  )
    return false;
  const ref = (v: unknown) =>
    typeof v === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(v);
  const fresh = (v: unknown) =>
    Number.isSafeInteger(v) &&
    typeof v === "number" &&
    v <= now &&
    v + 86400000 >= (p?.startedAt ?? Infinity) + 1800000;
  const a = x.allowances;
  return (
    x.policyVersion === "free-plan-v1" &&
    ref(x.reviewer) &&
    x.plan?.status === "free" &&
    ["owner-console", "provider-api"].includes(x.plan.source) &&
    fresh(x.plan.checkedAt) &&
    [x.plan.project, x.plan.branch, x.plan.period, x.plan.evidence].every(
      ref,
    ) &&
    x.billing?.source === "neon-free-no-overage-2026-11-19" &&
    fresh(x.billing.reviewedAt) &&
    ref(x.billing.evidence) &&
    !!a &&
    [
      a.postgresStorageBytes,
      a.requiredPostgresStorageBytes,
      a.postgresComputeCuSeconds,
      a.requiredPostgresComputeCuSeconds,
      a.sharedTransferBytes,
      a.requiredSharedTransferBytes,
    ].every((v) => Number.isSafeInteger(v) && v > 0) &&
    a.requiredPostgresStorageBytes >= 1048576 &&
    a.postgresStorageBytes >= a.requiredPostgresStorageBytes &&
    a.requiredPostgresComputeCuSeconds >= 28800 &&
    a.postgresComputeCuSeconds >= a.requiredPostgresComputeCuSeconds &&
    a.requiredSharedTransferBytes >= 1048576 &&
    a.sharedTransferBytes >= a.requiredSharedTransferBytes
  );
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
  if (e?.functionsMode === "free-plan-unknown-v1")
    return {
      unknownAllowanceAccepted: true,
      manualRecoveryReady: true,
      mode: e.functionsMode,
      verdict: "partial",
      functionsUsage: "unknown",
      functionsAllowance: "unknown",
      hardSpendingCap: false,
      policyVersion: "free-plan-v1",
      scenario: "64x60-plus36x60-v1",
      scenarioCapacitySeconds: 6000,
      scenarioInvocations: 100,
      shutdownBy: e.functionsPolicy?.shutdownBy,
    };
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
