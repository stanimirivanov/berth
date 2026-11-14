import {
  DefaultRequestSigner,
  SimpleAuthenticationDetailsProvider,
} from "oci-common";
import { Client } from "pg";
import { boundedObjectSdk } from "../providers/oci/client.js";
import { monitoringTransport } from "../providers/oci/usage.js";
import { runExecutor } from "./executor.js";
import { assertExecutorPrivileges } from "./executor-security.js";
import { executorStore } from "./executor-store.js";
import type { LedgerDatabase } from "./ledger.js";
import type { liveEnvironment } from "./live-environment.js";
import type { LiveAction } from "./live-hosted.js";
import { usageStore } from "./warnings.js";

/** Invocation-local SQL connection; the runtime closes it after all executor work settles. */
export interface LiveDatabase extends LedgerDatabase {
  /** Connect using restricted credentials with bounded timeouts. */
  connect(): Promise<unknown>;
  /** Release the invocation connection, including on uncertain outcomes. */
  end(): Promise<unknown>;
}
/** Local test seams replace only I/O; the ledger, signer and executor remain real. */
export interface LivePorts {
  database?: (connection: string) => LiveDatabase;
  fetch?: typeof fetch;
}
/** Construct single-send transports; merely constructing a signer dispatches no requests. */
export function liveTransports(
  e: ReturnType<typeof liveEnvironment>,
  fetcher: typeof fetch = fetch,
) {
  const signer = new DefaultRequestSigner(
    new SimpleAuthenticationDetailsProvider(
      e.tenancy,
      e.user,
      e.fingerprint,
      e.privateKey,
      null,
    ),
  );
  return {
    /** Creation cutoff comes from the authoritative ledger snapshot, never a caller payload. */
    sdk: (signal: AbortSignal, creationDeadline: number) =>
      boundedObjectSdk(signer, signal, fetcher, 5000, { creationDeadline }),
    usage: monitoringTransport(e.region, e.compartment, signer, fetcher),
  };
}
/**
 * Execute one fixed admitted operation. Identity/target/window drift fails before
 * claims or provider dispatch; SQL remains the budget and ownership authority.
 * This entry neither admits new trials nor asserts current provider IAM/allowances.
 */
export async function executeLive(
  e: ReturnType<typeof liveEnvironment>,
  action: LiveAction,
  delivery?: string,
  ports: LivePorts = {},
) {
  if (Date.now() < e.startedAt || Date.now() >= e.expiresAt)
    return { phase: "expired" };
  const db = ports.database
    ? ports.database(e.connection)
    : new Client({
        connectionString: e.connection,
        connectionTimeoutMillis: 5000,
        statement_timeout: 5000,
        query_timeout: 6000,
      });
  try {
    await db.connect();
    await assertExecutorPrivileges(db);
    const store = executorStore(db),
      snapshot = await store.report(e.operation),
      trial = snapshot?.trial;
    if (
      !trial ||
      trial.operation !== e.operation ||
      trial.compartment !== e.compartment ||
      trial.namespace !== e.namespace ||
      trial.region !== e.region ||
      Date.parse(trial.started_at) !== e.startedAt ||
      Date.parse(trial.expires_at) !== e.expiresAt
    )
      throw Error("Admitted target or window mismatch");
    if (Date.now() >= e.expiresAt) return { phase: "expired" };
    if (action === "cleanup") return await store.cleanup(e.operation);
    if (action === "usage") return await usageStore(db).report(e.operation);
    if (action === "evidence")
      return {
        operation: e.operation,
        phase: snapshot.phase,
        status: trial.outcome,
        reason: snapshot.reason,
        objectRemoved: snapshot.object_removed,
        startedAt: trial.started_at,
        expiresAt: trial.expires_at,
      };
    if (!delivery) throw Error("Missing delivery");
    const transports = liveTransports(e, ports.fetch);
    // Await is essential: finally must not close SQL while the executor is still running.
    return await runExecutor(db, {
      operation: e.operation,
      delivery,
      expiresAt: e.expiresAt,
      usage: transports.usage,
      sdk: (signal, session) =>
        transports.sdk(signal, session.creationDeadline),
    });
  } finally {
    await db.end();
  }
}
