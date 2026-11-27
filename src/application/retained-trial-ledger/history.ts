import {
  decodeHistoryDetail,
  decodeHistoryPage,
  type HistoryRead,
} from "../history/contract.ts";
import {
  type HostedPostgresConfig,
  hostedPostgresClient,
} from "./hosted-postgres.ts";
import { type RetainedTrialDatabase, retainedTrialResult } from "./sql.ts";

/** Hold the restricted client inside the adapter for one History invocation. */
interface HistoryDatabase extends RetainedTrialDatabase {
  connect(): Promise<unknown>;
  end(): Promise<unknown>;
}

/** Require the same dedicated, unpooled History login in both injected URLs. */
function historyConnection(
  env: Record<string, string | undefined>,
): HostedPostgresConfig {
  const configured = env.DATABASE_URL_UNPOOLED ?? "";
  if (env.DATABASE_URL !== configured || !URL.canParse(configured))
    throw Error("Restricted connection required");
  const url = new URL(configured);
  if (
    url.protocol !== "postgresql:" ||
    url.username !== "berth_history_runtime" ||
    !url.password ||
    !/^ep-[a-z0-9-]+\.[a-z0-9.-]+\.neon\.tech$/.test(url.hostname) ||
    url.hostname.split(".")[0]?.endsWith("-pooler") ||
    (url.port && url.port !== "5432") ||
    url.pathname !== "/neondb" ||
    url.hash ||
    [...url.searchParams].some(
      ([key, value]) =>
        url.searchParams.getAll(key).length !== 1 ||
        !(
          (key === "sslmode" && ["require", "verify-full"].includes(value)) ||
          (key === "channel_binding" && value === "require")
        ),
    )
  )
    throw Error("Restricted connection required");
  const password = decodeURIComponent(url.password);
  if (
    [
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "NEON_AI_GATEWAY_TOKEN",
    ].some((key) => env[key] && env[key] !== "disabled-for-berth-probe") ||
    (env.PGPASSWORD &&
      env.PGPASSWORD !== "disabled-for-berth-probe" &&
      env.PGPASSWORD !== password)
  )
    throw Error("Unexpected injected credentials");
  return {
    host: url.hostname,
    port: 5432,
    database: "neondb",
    user: url.username,
    password,
    ssl: { rejectUnauthorized: true },
    enableChannelBinding: true,
    requireChannelBinding: url.searchParams.has("channel_binding"),
    connectionTimeoutMillis: 3000,
    query_timeout: 5000,
    statement_timeout: 2000,
    options: "-c search_path=pg_catalog,pg_temp",
  };
}

/** Reject a wrong login or privilege drift before executing either projection. */
async function assertHistoryPrivileges(db: RetainedTrialDatabase) {
  const { rows } = await db.query(`WITH projections(oid) AS (
    VALUES ('berth_executor.history_page(uuid,integer)'::regprocedure),
           ('berth_executor.history_detail(uuid)'::regprocedure)
  )
  SELECT current_user = 'berth_history_runtime'
    AND session_user = current_user AND current_database() = 'neondb'
    AND r.rolcanlogin AND NOT (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole
      OR r.rolreplication OR r.rolbypassrls OR r.rolinherit)
    AND NOT EXISTS (SELECT FROM pg_auth_members WHERE member = r.oid)
    AND NOT EXISTS (SELECT FROM pg_database WHERE datdba = r.oid)
    AND NOT has_database_privilege(r.oid, current_database(), 'CREATE,TEMP')
    AND has_schema_privilege(r.oid, 'berth_executor', 'USAGE')
    AND NOT EXISTS (
      SELECT FROM projections p
      WHERE NOT has_function_privilege(r.oid, p.oid, 'EXECUTE')
        OR has_function_privilege(r.oid, p.oid, 'EXECUTE WITH GRANT OPTION')
    )
    AND NOT EXISTS (
      SELECT FROM pg_namespace n WHERE n.nspname NOT LIKE 'pg_temp%'
        AND (n.nspowner = r.oid OR has_schema_privilege(r.oid, n.oid, 'CREATE'))
    )
    AND NOT EXISTS (
      SELECT FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE left(n.nspname, 3) <> 'pg_' AND n.nspname <> 'information_schema'
        AND (c.relowner = r.oid OR CASE
          WHEN c.relkind IN ('r','p','v','m','f') THEN
            has_table_privilege(r.oid, c.oid,
              'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
            OR has_any_column_privilege(r.oid, c.oid, 'SELECT,INSERT,UPDATE,REFERENCES')
          WHEN c.relkind = 'S' THEN has_sequence_privilege(r.oid, c.oid, 'USAGE,SELECT,UPDATE')
          ELSE false
        END)
    )
    AND NOT EXISTS (
      SELECT FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE left(n.nspname, 3) <> 'pg_' AND n.nspname <> 'information_schema'
        AND (p.proowner = r.oid OR (
          has_schema_privilege(r.oid, n.oid, 'USAGE')
          AND has_function_privilege(r.oid, p.oid, 'EXECUTE')
          AND p.oid NOT IN (SELECT oid FROM projections)
        ))
    )
    AS restricted FROM pg_roles r WHERE r.rolname = current_user`);
  if (rows.length !== 1 || rows[0]?.restricted !== true)
    throw Error("History database privilege boundary failed");
}

/** Read only the existing owner-reviewed History functions on a read-only connection. */
function retainedHistoryLedger(db: RetainedTrialDatabase): HistoryRead {
  /** Preserve the existing History error contract and redact SQL diagnostics. */
  async function read<T>(
    decode: (value: unknown) => T,
    text: string,
    parameters: unknown[],
  ): Promise<T> {
    try {
      return decode(await retainedTrialResult(db, text, parameters));
    } catch {
      throw Error("Executor state unavailable; reconcile without retry");
    }
  }

  return {
    /** Fetch one bounded page without applying the original operation expiry. */
    list: (before: string | null = null, limit = 20) =>
      read(
        decodeHistoryPage,
        "SELECT berth_executor.history_page($1,$2) AS result",
        [before, limit],
      ),
    /** Fetch the retained summary or null, using no execution capability. */
    detail: (operation: string) =>
      read(
        decodeHistoryDetail,
        "SELECT berth_executor.history_detail($1) AS result",
        [operation],
      ),
  };
}

/** Open and close one checked read-only session per History read. */
export function historyReader(
  env: Record<string, string | undefined>,
  database: (
    configuration: HostedPostgresConfig,
  ) => HistoryDatabase = hostedPostgresClient,
): HistoryRead {
  let busy = false;

  /** Keep each read inside one checked transaction and release it before the next read. */
  async function withLedger<T>(read: (ledger: HistoryRead) => Promise<T>) {
    if (
      busy ||
      Object.keys(env).some((key) => key.startsWith("OCI_") && env[key])
    )
      throw Error("History unavailable");
    const db = database(historyConnection(env));
    busy = true;
    try {
      await db.connect();
      await db.query("BEGIN READ ONLY");
      await assertHistoryPrivileges(db);
      return await read(retainedHistoryLedger(db));
    } finally {
      try {
        await db.end();
      } finally {
        busy = false;
      }
    }
  }

  return {
    list: (before, limit) => withLedger((ledger) => ledger.list(before, limit)),
    detail: (operation) => withLedger((ledger) => ledger.detail(operation)),
  };
}
