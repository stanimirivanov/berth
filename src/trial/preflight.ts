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
    sharedTransferBytes?: number;
    requiredSharedTransferBytes: number;
  };
}
/** Explicit normalized capacity with original observation retained; no automatic unit conversion. */
export interface AllowanceMeter {
  observed: number | "not-exposed";
  unit: string;
  remaining: number | "unknown";
  required: number;
  knownInsufficient: false;
  coverage: "complete" | "partial" | "unavailable";
  sourceRef: string;
  periodRef: string;
  checkedAt: number;
  normalizationRef?: string;
}
/** Closed exception scope; storage, Postgres and eligibility cannot be waived. */
export interface AllowanceException {
  version: "issue76-once-v1";
  issue: 76;
  approvalRef: string;
  unknownActivityAccepted: true;
  quotaFailureAccepted: true;
  ociFree: {
    status: "free-tier";
    source: "owner-console" | "provider-api";
    checkedAt: number;
    evidence: string;
    billingEvidence: string;
    billingReviewedAt: number;
  };
  meters: Record<
    | "neonSharedTransfer"
    | "ociObjectRequests"
    | "ociOutboundTransfer"
    | "ociMonitoringIngestion"
    | "ociMonitoringRetrieval",
    AllowanceMeter
  >;
}
/** Owner aggregate attestation, not a provider billing API or hard spending guarantee. */
export interface Headroom {
  checkedAt: number;
  accountType: string;
  homeRegion: string;
  storageBytes: number;
  objectRequests?: number;
  transferBytes?: number;
  monitoringRequests?: number;
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
  allowanceException?: AllowanceException;
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
  if (e.allowanceException !== undefined)
    return validBoundedAllowance(c, e, now, prepared)
      ? []
      : ["bounded-allowance-invalid"];
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
  unknownShared = false,
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
      a.requiredSharedTransferBytes,
    ].every((v) => Number.isSafeInteger(v) && v > 0) &&
    a.requiredPostgresStorageBytes >= 1048576 &&
    a.postgresStorageBytes >= a.requiredPostgresStorageBytes &&
    a.requiredPostgresComputeCuSeconds >= 28800 &&
    a.postgresComputeCuSeconds >= a.requiredPostgresComputeCuSeconds &&
    a.requiredSharedTransferBytes >= 1048576 &&
    (unknownShared
      ? !("sharedTransferBytes" in a)
      : Number.isSafeInteger(a.sharedTransferBytes) &&
        (a.sharedTransferBytes ?? -1) >= a.requiredSharedTransferBytes)
  );
}

/** A waiver is explicit and narrow; unknown data never passes through the strict validator as fake quota. */
function validBoundedAllowance(
  c: TrialConfiguration,
  e: Partial<Headroom>,
  now: number,
  p?: PreparedTrial,
) {
  const x = e.allowanceException;
  const ref = (v: unknown) =>
    typeof v === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(v);
  const fresh = (v: unknown) =>
    typeof v === "number" &&
    Number.isSafeInteger(v) &&
    v <= now &&
    v + 86400000 >= (p?.startedAt ?? Infinity) + 1800000;
  if (
    !x ||
    e.functionsMode !== "free-plan-unknown-v1" ||
    e.accountType !== "always-free" ||
    c.monitoringLimit !== 20 ||
    !Number.isSafeInteger(e.checkedAt) ||
    !Number.isSafeInteger(e.storageBytes) ||
    (e.storageBytes ?? 0) < 10485760 ||
    ["objectRequests", "transferBytes", "monitoringRequests"].some(
      (k) => k in e,
    ) ||
    !validFunctionsPolicy(c, e, now, p, true) ||
    x.version !== "issue76-once-v1" ||
    x.issue !== 76 ||
    !ref(x.approvalRef) ||
    x.unknownActivityAccepted !== true ||
    x.quotaFailureAccepted !== true ||
    x.ociFree?.status !== "free-tier" ||
    !["owner-console", "provider-api"].includes(x.ociFree.source) ||
    !fresh(x.ociFree.checkedAt) ||
    !fresh(x.ociFree.billingReviewedAt) ||
    !ref(x.ociFree.evidence) ||
    !ref(x.ociFree.billingEvidence)
  )
    return false;
  const floors = {
    neonSharedTransfer:
      e.functionsPolicy?.allowances.requiredSharedTransferBytes ?? Infinity,
    ociObjectRequests: 200,
    ociOutboundTransfer: 1048576,
    ociMonitoringIngestion: 1,
    ociMonitoringRetrieval: 100,
  };
  if (
    !x.meters ||
    Object.keys(x.meters).sort().join(",") !==
      Object.keys(floors).sort().join(",")
  )
    return false;
  return Object.entries(floors).every(([key, minimum]) => {
    const m = x.meters[key as keyof typeof floors];
    const units: Record<string, Record<string, number>> = {
      neonSharedTransfer: { bytes: 1 },
      ociObjectRequests: { requests: 1, "10K Requests": 10000 },
      ociOutboundTransfer: { bytes: 1, GB: 1000000000, "GB Months": 0 },
      ociMonitoringIngestion: { datapoints: 1, "Million Datapoints": 1000000 },
      ociMonitoringRetrieval: { datapoints: 1, "Million Datapoints": 1000000 },
    };
    const caps: Record<string, number> = {
      neonSharedTransfer: 5000000000,
      ociObjectRequests: 50000,
      ociOutboundTransfer: 10000000000000,
      ociMonitoringIngestion: 500000000,
      ociMonitoringRetrieval: 1000000000,
    };
    if (
      !m ||
      !Number.isSafeInteger(m.required) ||
      m.required < minimum ||
      m.required > (caps[key] ?? 0) ||
      m.knownInsufficient !== false ||
      !ref(m.sourceRef) ||
      !ref(m.periodRef) ||
      !fresh(m.checkedAt)
    )
      return false;
    if (m.observed === "not-exposed")
      return (
        m.unit === "not-exposed" &&
        m.remaining === "unknown" &&
        m.coverage === "unavailable"
      );
    const factor = units[key]?.[m.unit];
    if (
      typeof m.observed !== "number" ||
      !Number.isFinite(m.observed) ||
      m.observed < 0 ||
      m.observed > Number.MAX_SAFE_INTEGER ||
      factor === undefined
    )
      return false;
    const consumed =
      factor > 0
        ? normalizedConsumption(m.observed, factor, caps[key] ?? 0)
        : 0;
    if (factor > 0 && consumed + m.required > (caps[key] ?? 0)) return false;
    if (m.remaining === "unknown") return m.coverage === "partial";
    return (
      factor > 0 &&
      m.coverage === "complete" &&
      ref(m.normalizationRef) &&
      Number.isSafeInteger(m.remaining) &&
      m.remaining >= m.required &&
      m.remaining <= (caps[key] ?? 0) - consumed
    );
  });
}

/** Match SQL numeric/ceil exactly; binary float rounding must not change a quota boundary. */
function normalizedConsumption(value: number, factor: number, cap: number) {
  const [mantissa = "0", exponent = "0"] = String(value).split("e");
  const scale = (mantissa.split(".")[1]?.length ?? 0) - Number(exponent);
  let numerator = BigInt(mantissa.replace(".", "")) * BigInt(factor);
  const denominator = 10n ** BigInt(Math.max(scale, 0));
  if (scale < 0) numerator *= 10n ** BigInt(-scale);
  const rounded = (numerator + denominator - 1n) / denominator;
  return rounded > BigInt(cap) ? Infinity : Number(rounded);
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
export function proposal(
  c: TrialConfiguration,
  operation: string,
  preparedBucket?: string,
) {
  return {
    target: {
      compartment: c.compartment,
      namespace: c.namespace,
      region: c.region,
    },
    bucket: {
      name: preparedBucket ?? `berth-${operation.replaceAll("-", "")}`,
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
      ...(e.allowanceException
        ? { allowanceException: e.allowanceException }
        : {}),
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
