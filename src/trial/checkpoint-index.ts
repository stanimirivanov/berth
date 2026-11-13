import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { makeCheckpointHandler } from "./checkpoint-handler.js";
import { runCheckpoint } from "./checkpoint-run.js";

const boot = randomUUID();
/** Checks both injected URLs and unused service credentials before any database connection. */
export function checkpointDatabaseUrl(
  env: Record<string, string | undefined>,
  nodeVersion: string,
) {
  if (nodeVersion.split(".")[0] !== "24") throw Error("Runtime mismatch");
  for (const name of ["NEON_API_KEY", "OCI_PRIVATE_KEY", "OCI_ADMIN_KEY"])
    if (env[name]) throw Error("Admin credential");
  for (const name of [
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "NEON_AI_GATEWAY_TOKEN",
  ])
    if (env[name] && env[name] !== "disabled-for-berth-probe")
      throw Error("Service credential");
  let uri: URL | undefined;
  for (const name of ["DATABASE_URL", "DATABASE_URL_UNPOOLED"]) {
    uri = new URL(env[name] ?? "");
    if (
      uri.protocol !== "postgresql:" ||
      uri.username !== "berth_runtime" ||
      uri.pathname !== "/neondb" ||
      !uri.hostname.endsWith(".neon.tech")
    )
      throw Error("Connection mismatch");
  }
  if (!uri) throw Error("Missing connection");
  uri.searchParams.set("sslmode", "verify-full");
  return uri.href;
}
/** Owns one bounded connection per invocation; errors are discarded at HTTP boundary. */
async function execute(idHash?: string) {
  const db = new Client({
    connectionString: checkpointDatabaseUrl(process.env, process.versions.node),
    connectionTimeoutMillis: 5000,
    statement_timeout: 5000,
    query_timeout: 6000,
  });
  const start = performance.now();
  try {
    await db.connect();
    if (
      (await db.query("SELECT current_user='berth_runtime' AS restricted"))
        .rows[0]?.restricted !== true
    )
      throw Error("Role mismatch");
    const result = idHash
      ? await runCheckpoint(db, idHash, boot)
      : (await db.query("SELECT berth_state.probe_report() AS report")).rows[0]
          ?.report;
    return {
      result,
      boot,
      node: process.versions.node,
      elapsedMs: Math.round(performance.now() - start),
      memoryBytes: process.memoryUsage().rss,
      digest: process.env.BERTH_BUILD_DIGEST,
    };
  } finally {
    await db.end();
  }
}
/** Only Neon's attested scheduler mutates; bearer evidence is read-only. No OCI credentials. */
export default makeCheckpointHandler({
  token: process.env.BERTH_TRIAL_TOKEN ?? "",
  expiresAt: Number(process.env.BERTH_PROBE_EXPIRES_AT),
  run: (id) => execute(id),
  evidence: () => execute(),
});
