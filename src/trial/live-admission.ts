import { randomUUID } from "node:crypto";
import { makeTrialApi } from "./api.js";
import { executorStore } from "./executor-store.js";
import { type LedgerDatabase, makeLedger } from "./ledger.js";
import type { liveEnvironment } from "./live-environment.js";
import { preflight } from "./preflight.js";

/** Owner-prepared identity plus explicit independent service ceilings. */
export function admissionBinding(e: ReturnType<typeof liveEnvironment>) {
  return {
    compartment: e.compartment,
    namespace: e.namespace,
    region: e.region,
    tenancy: e.tenancy,
    user: e.user,
    fingerprint: e.fingerprint,
    monitoringLimit: e.monitoringLimit,
    neonLimit: e.neonLimit,
  };
}
/** Read-only projection; SQL refuses a changed identity, key or target before any provider work. */
export async function admissionStatus(
  db: LedgerDatabase,
  e: ReturnType<typeof liveEnvironment>,
) {
  return (
    await db.query("SELECT berth_executor.admission_status($1,$2) AS result", [
      e.operation,
      JSON.stringify(admissionBinding(e)),
    ])
  ).rows[0]?.result as {
    admitted: boolean;
    verifiedAt: number | null;
    evidence: unknown;
  };
}
/** Each admitted HTTP call spends a Neon reservation; provider-side rejected invocations remain outside this app cap. */
export async function meterAdmission(
  db: LedgerDatabase,
  e: ReturnType<typeof liveEnvironment>,
  purpose: "admission" | "control" | "cleanup" | "scheduled" = "admission",
) {
  await db.query("SELECT berth_executor.meter_http($1,$2,$3,$4)", [
    e.operation,
    JSON.stringify(admissionBinding(e)),
    randomUUID(),
    purpose,
  ]);
}
/** Reuses a five-minute receipt; failed/uncertain checks remain spent and never authorize submission. */
export async function verifyAdmission(
  db: LedgerDatabase,
  e: ReturnType<typeof liveEnvironment>,
  check: (kind: "namespace" | "empty") => Promise<boolean>,
) {
  if ((await admissionStatus(db, e)).admitted) return true;
  const ledger = makeLedger(db),
    c = await ledger.claim(e.operation, randomUUID());
  try {
    const status = await admissionStatus(db, e);
    if (
      status.admitted ||
      (status.verifiedAt !== null &&
        Date.now() >= Number(status.verifiedAt) &&
        Date.now() - Number(status.verifiedAt) < 300000)
    )
      return true;
    if (Date.now() >= e.startedAt + 300000) return false;
    const attempt = await ledger.begin(c, randomUUID(), "inspect");
    for (const kind of ["namespace", "empty"] as const) {
      const r = await ledger.reserve(c, attempt, randomUUID());
      if (!r.fresh) throw Error("Reservation not fresh");
      let valid = false;
      try {
        valid = await check(kind);
      } catch {
        await ledger.settle(c, r.id, "rejected", "read-only-interruption");
        await ledger.end(c, attempt, "failed");
        return false;
      }
      await ledger.settle(
        c,
        r.id,
        valid ? "succeeded" : "rejected",
        "provider-response",
      );
      if (!valid) {
        await ledger.end(c, attempt, "failed");
        return false;
      }
    }
    await db.query("SELECT berth_executor.admission_verified($1,$2,$3,$4,$5)", [
      e.operation,
      c.owner,
      c.generation,
      JSON.stringify(admissionBinding(e)),
      attempt,
    ]);
    return true;
  } finally {
    await ledger.release(c);
  }
}
/** Connect the signed API to the prepared SQL gate; preview can persist charged read-only checks. */
export function liveAdmissionApi(
  db: LedgerDatabase,
  e: ReturnType<typeof liveEnvironment>,
  check: (kind: "namespace" | "empty") => Promise<boolean>,
) {
  const configuration = {
    compartment: e.compartment,
    namespace: e.namespace,
    region: e.region,
    monitoringLimit: e.monitoringLimit,
    neonLimit: e.neonLimit,
  };
  return makeTrialApi({
    binding: JSON.stringify([admissionBinding(e), e.startedAt, e.expiresAt]),
    token: e.token,
    previewKey: e.previewKey,
    operation: e.operation,
    configuration,
    headroom: async () => {
      const status = await admissionStatus(db, e),
        evidence = status.evidence as {
          iamReviewed?: boolean;
          iamCheckedAt?: number;
        };
      const now = Date.now();
      if (
        evidence?.iamReviewed !== true ||
        !Number.isFinite(evidence.iamCheckedAt) ||
        (evidence.iamCheckedAt ?? Infinity) > now ||
        now - (evidence.iamCheckedAt ?? 0) > 86400000 ||
        preflight(configuration, evidence, now).length ||
        (!status.admitted && now >= e.startedAt + 300000)
      )
        return null;
      return evidence;
    },
    verifyCredentials: () => verifyAdmission(db, e, check),
    ledger: {
      start: async () => {
        await db.query("SELECT berth_executor.admit($1,$2)", [
          e.operation,
          JSON.stringify(admissionBinding(e)),
        ]);
        return (await executorStore(db).report(e.operation)).trial;
      },
    },
    admitCleanup: async (operation) => {
      if (operation !== e.operation) throw Error("Wrong operation");
      return executorStore(db).cleanup(operation);
    },
  });
}
