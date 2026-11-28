import { decodeStorageSnapshot } from "../../../contracts/oci-storage.ts";
import type {
  StorageEvidence,
  StorageRepository,
} from "../../application/oci-storage/contract.ts";
import {
  type HostedPostgresConfig,
  hostedPostgresClient,
} from "../../application/retained-trial-ledger/hosted-postgres.ts";

/** Validate the dedicated login, host, and TLS options before connecting. */
function storageConnection(
  env: Record<string, string | undefined>,
): HostedPostgresConfig {
  const configured = env.BERTH_OCI_STORAGE_DATABASE_URL;
  const url = new URL(configured ?? "");
  if (
    [env.DATABASE_URL, env.DATABASE_URL_UNPOOLED].some(
      (value) => value !== undefined && value !== configured,
    ) ||
    url.protocol !== "postgresql:" ||
    url.username !== "berth_oci_storage_runtime" ||
    !url.password ||
    !/^ep-[a-z0-9-]+\.[a-z0-9.-]+\.neon\.tech$/.test(url.hostname) ||
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
    throw Error("OCI storage database unavailable");
  return {
    host: url.hostname,
    port: 5432,
    database: "neondb",
    user: url.username,
    password: decodeURIComponent(url.password),
    ssl: { rejectUnauthorized: true },
    enableChannelBinding: true,
    requireChannelBinding: url.searchParams.has("channel_binding"),
    connectionTimeoutMillis: 1000,
    statement_timeout: 1000,
    query_timeout: 1500,
  };
}

/** Fail closed before a read or claim if the dedicated login has acquired broader Berth access. */
const verifyStorageRole = `SELECT
  current_user = 'berth_oci_storage_runtime' AND session_user = current_user
    AND current_database() = 'neondb' AND r.rolcanlogin
    AND NOT (r.rolsuper OR r.rolinherit OR r.rolcreatedb OR r.rolcreaterole
      OR r.rolreplication OR r.rolbypassrls OR has_database_privilege(r.oid, current_database(), 'CREATE'))
    AND NOT EXISTS (SELECT FROM pg_auth_members WHERE member = r.oid)
    AND NOT EXISTS (SELECT FROM pg_namespace n WHERE n.nspname NOT LIKE 'pg_temp%'
      AND has_schema_privilege(r.oid, n.oid, 'CREATE'))
    AND NOT EXISTS (
      SELECT FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE left(n.nspname, 6) = 'berth_' AND (
        has_table_privilege(r.oid, c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        OR has_any_column_privilege(r.oid, c.oid, 'SELECT,INSERT,UPDATE,REFERENCES')
      )
    )
    AND NOT EXISTS (
      SELECT FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE left(n.nspname, 6) = 'berth_'
        AND has_function_privilege(r.oid, p.oid, 'EXECUTE')
        AND NOT (n.nspname = 'berth_oci_allowances' AND
          p.oid IN ('berth_oci_allowances.storage_snapshot(text)'::regprocedure,
                    'berth_oci_allowances.claim_storage(text,timestamptz)'::regprocedure,
                    'berth_oci_allowances.finish_storage(text,timestamptz,text,jsonb)'::regprocedure))
    )
  AS restricted FROM pg_roles r WHERE r.rolname = current_user`;

/** Expose only the alert snapshot and two bounded settlement operations for one configured tenancy. */
export function storageRepository(
  tenancy: string,
  env: Record<string, string | undefined>,
  client = hostedPostgresClient,
): StorageRepository {
  /** Open a short-lived, verified-TLS connection. Application code cannot execute free-form SQL. */
  async function query(text: string, parameters: unknown[] = []) {
    if (!/^ocid1\.tenancy\.oc1\.\.[A-Za-z0-9]{1,128}$/.test(tenancy))
      throw Error("Invalid storage tenancy");
    const connection = client(storageConnection(env));
    try {
      await connection.connect();
      const check = await connection.query(verifyStorageRole);
      if (check.rows.length !== 1 || check.rows[0]?.restricted !== true)
        throw Error("OCI storage database privilege boundary failed");
      const { rows } = await connection.query(text, [tenancy, ...parameters]);
      if (rows.length !== 1) throw Error("OCI storage database unavailable");
      return rows[0]?.result as unknown;
    } finally {
      await connection.end();
    }
  }

  return {
    /** Read the latest snapshot without contacting the provider or changing its freshness. */
    async read() {
      return decodeStorageSnapshot(
        await query(
          "SELECT berth_oci_allowances.storage_snapshot($1) AS result",
        ),
      );
    },
    /** Charge one refresh slot durably before performing either OCI read. */
    async claim(attemptedAt: string) {
      const result = await query(
        "SELECT berth_oci_allowances.claim_storage($1, $2) AS result",
        [attemptedAt],
      );
      if (typeof result !== "boolean") throw Error("Storage claim unavailable");
      return result;
    },
    /** Settle the same claim only. A failed attempt retains the previous dated reading. */
    async finish(attemptedAt: string, evidence: StorageEvidence) {
      await query(
        "SELECT berth_oci_allowances.finish_storage($1, $2, $3, $4) AS result",
        [attemptedAt, evidence.gap, evidence.reading],
      );
    },
  };
}
