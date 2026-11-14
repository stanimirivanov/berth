import { createHash, timingSafeEqual } from "node:crypto";
import { Client } from "pg";
import { runExecutor } from "./executor.js";
import { executorStore } from "./executor-store.js";
import { type SyntheticCloud, syntheticSdk } from "./executor-synthetic.js";
import { scheduledHandler } from "./scheduled.js";

/** Restricted proof-only connection; neither administrator nor OCI credentials are accepted. */
export function executorEnvironment(env: Record<string, string | undefined>) {
  for (const name of Object.keys(env))
    if (/^(?:OCI_|NEON_API_KEY)/.test(name) && env[name])
      throw Error(
        name.startsWith("OCI_")
          ? "Unexpected OCI credentials"
          : "Unexpected API key",
      );
  for (const name of [
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "NEON_AI_GATEWAY_TOKEN",
  ])
    if (env[name] && env[name] !== "disabled-for-berth-probe")
      throw Error("Unexpected injected credentials");
  let connection = "";
  for (const name of ["DATABASE_URL", "DATABASE_URL_UNPOOLED"]) {
    const url = new URL(env[name] ?? "");
    if (
      url.protocol !== "postgresql:" ||
      url.username !== "berth_runtime" ||
      url.pathname !== "/neondb" ||
      !url.hostname.endsWith(".neon.tech")
    )
      throw Error("Restricted connection required");
    if (
      env.PGPASSWORD &&
      env.PGPASSWORD !== "disabled-for-berth-probe" &&
      env.PGPASSWORD !== decodeURIComponent(url.password)
    )
      throw Error("Unexpected database password");
    url.searchParams.set("sslmode", "verify-full");
    connection = url.href;
  }
  const startedAt = Number(env.BERTH_EXECUTOR_STARTED_AT),
    expiresAt = Number(env.BERTH_EXECUTOR_EXPIRES_AT),
    operation = env.BERTH_EXECUTOR_OPERATION ?? "";
  if (
    !Number.isFinite(startedAt) ||
    expiresAt - startedAt !== 14400000 ||
    !/^[a-f0-9-]{36}$/.test(operation) ||
    env.BERTH_EXECUTOR_MODE !== "synthetic" ||
    !/^[A-Za-z0-9_-]{32,128}$/.test(env.BERTH_TRIAL_TOKEN ?? "")
  )
    throw Error("Invalid executor deployment");
  return {
    connection,
    startedAt,
    expiresAt,
    operation,
    token: env.BERTH_TRIAL_TOKEN ?? "",
  };
}
/** One bounded restricted connection; runtime never installs schema or reads owner files. */
export async function execute(
  e: ReturnType<typeof executorEnvironment>,
  delivery?: string,
) {
  const db = new Client({
    connectionString: e.connection,
    connectionTimeoutMillis: 5000,
    statement_timeout: 5000,
    query_timeout: 6000,
  });
  try {
    await db.connect();
    if (
      (await db.query("SELECT current_user='berth_runtime' AS restricted"))
        .rows[0]?.restricted !== true
    )
      throw Error("Role mismatch");
    if (!delivery) {
      const snapshot = await executorStore(db).report(e.operation);
      return {
        phase: snapshot.phase,
        status: snapshot.trial.outcome,
        reason: snapshot.reason,
        objectRemoved: snapshot.object_removed,
        startedAt: snapshot.trial.started_at,
        expiresAt: snapshot.trial.expires_at,
      };
    }
    // Await before finally closes the connection; returning the promise closes it early.
    return await runExecutor(db, {
      operation: e.operation,
      delivery,
      expiresAt: e.expiresAt,
      // Synthetic proof never pretends that fixture observations are live OCI metrics.
      usage: async () => [],
      sdk: (_signal, { claim, snapshot, store }) =>
        syntheticSdk(
          {
            operation: e.operation,
            namespace: snapshot.trial.namespace,
            compartment: snapshot.trial.compartment,
            region: snapshot.trial.region,
            bucket: snapshot.trial.bucket,
            marker: snapshot.trial.marker,
          },
          (value) =>
            store.access<SyntheticCloud>(claim, "synthetic", value ?? null),
        ),
    });
  } finally {
    await db.end();
  }
}
/** Hosted synthetic proof shares the real executor/ledger/Alchemy path, with no OCI transport. */
export default {
  /** Expired requests return before environment credentials are parsed or a connection is created. */
  async fetch(request: Request) {
    const expires = Number(process.env.BERTH_EXECUTOR_EXPIRES_AT);
    if (!Number.isFinite(expires) || Date.now() >= expires)
      return Response.json({ phase: "expired" });
    try {
      const e = executorEnvironment(process.env);
      if (new URL(request.url).pathname === "/evidence") {
        const supplied = request.headers.get("authorization") ?? "";
        if (
          request.method !== "POST" ||
          new URL(request.url).search ||
          supplied.length > 256 ||
          !timingSafeEqual(
            createHash("sha256").update(supplied).digest(),
            createHash("sha256").update(`Bearer ${e.token}`).digest(),
          )
        )
          return new Response(null, { status: 401 });
        return Response.json(await execute(e), {
          headers: { "cache-control": "no-store" },
        });
      }
      const response = await scheduledHandler({
        ...e,
        run: (delivery) => execute(e, delivery),
      }).fetch(request);
      console.info(
        JSON.stringify({
          event: "berth-schedule-response",
          status: response.status,
        }),
      );
      return response;
    } catch (error) {
      const allowed = [
        "Unexpected OCI credentials",
        "Unexpected database password",
        "Unexpected API key",
        "Unexpected injected credentials",
        "Restricted connection required",
        "Invalid executor deployment",
        "Invalid URL",
        "Role mismatch",
      ];
      const reason =
        error instanceof Error && allowed.includes(error.message)
          ? error.message
          : "Execution unavailable";
      return Response.json(
        { error: "executor-unavailable", reason },
        { status: 503 },
      );
    }
  },
};
