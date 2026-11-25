import {
  decodeInventoryPage,
  type InventoryPage,
  type InventoryReader,
} from "../inventory/contract.ts";
import {
  type HostedPostgresConfig,
  hostedPostgresClient,
} from "./hosted-postgres.ts";
import { type RetainedTrialDatabase, retainedTrialResult } from "./sql.ts";

/** Private database connection managed by the retained Inventory adapter. */
export interface InventoryDatabase extends RetainedTrialDatabase {
  connect(): Promise<unknown>;
  end(): Promise<unknown>;
}

/** Bind the dedicated login to the expected database and enforce verified TLS. */
function inventoryConnection(
  env: Record<string, string | undefined>,
): HostedPostgresConfig {
  const configured = env.BERTH_INVENTORY_DATABASE_URL;
  const url = new URL(configured ?? "");
  if (
    [env.DATABASE_URL, env.DATABASE_URL_UNPOOLED].some(
      (injected) => injected !== undefined && injected !== configured,
    ) ||
    url.protocol !== "postgresql:" ||
    url.username !== "berth_inventory_runtime" ||
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
    throw Error("Inventory database unavailable");
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
    idle_in_transaction_session_timeout: 3500,
  };
}

/** Fail closed on login or grant drift before switching to the reader capability. */
async function assertInventoryRole(db: RetainedTrialDatabase) {
  const { rows } = await db.query(`SELECT
    current_user = 'berth_inventory_runtime'
    AND session_user = current_user AND current_database() = 'neondb'
    AND login.rolcanlogin AND NOT capability.rolcanlogin
    AND EXISTS (
      SELECT FROM pg_auth_members m
      WHERE m.member = login.oid AND m.roleid = capability.oid
        AND m.set_option AND NOT (m.inherit_option OR m.admin_option)
    )
    AND NOT EXISTS (
      SELECT FROM pg_auth_members m
      WHERE m.member IN (login.oid, capability.oid)
        AND NOT (m.member = login.oid AND m.roleid = capability.oid)
    )
    AND NOT EXISTS (
      SELECT FROM pg_roles r WHERE r.oid IN (login.oid, capability.oid) AND (
        r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication
        OR r.rolbypassrls OR r.rolinherit
        OR has_database_privilege(r.oid, current_database(), 'CREATE,TEMP')
        OR EXISTS (SELECT FROM pg_namespace n WHERE n.nspname NOT LIKE 'pg_temp%'
          AND has_schema_privilege(r.oid, n.oid, 'CREATE'))
        OR EXISTS (
          SELECT FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE left(n.nspname, 6) = 'berth_' AND
            (has_table_privilege(r.oid, c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
            OR has_any_column_privilege(r.oid, c.oid, 'SELECT,INSERT,UPDATE,REFERENCES'))
        )
        OR EXISTS (
          SELECT FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE left(n.nspname, 6) = 'berth_'
            AND NOT (n.nspname = 'berth_inventory' AND p.proname = 'inventory_page'
              AND p.pronargs = 2 AND p.proargtypes[0] = 'uuid'::regtype
              AND p.proargtypes[1] = 'integer'::regtype)
            AND has_function_privilege(r.oid, p.oid, 'EXECUTE')
        )
      )
    )
    AS restricted
    FROM pg_roles login, pg_roles capability
    WHERE login.rolname = 'berth_inventory_runtime'
      AND capability.rolname = 'berth_inventory_reader'`);
  if (rows.length !== 1 || rows[0]?.restricted !== true)
    throw Error("Inventory database privilege boundary failed");
}

/** Perform one bounded read at a time, retaining the raw database session inside this adapter. */
export function inventoryReader(
  env: Record<string, string | undefined>,
  database: (
    config: HostedPostgresConfig,
  ) => InventoryDatabase = hostedPostgresClient,
): InventoryReader {
  let busy = false;
  return {
    /** Check the login in a read-only transaction and release the connection on every outcome. */
    async page(after = null, limit = 20) {
      if (busy) throw Error("Inventory read already in progress");
      const db = database(inventoryConnection(env));
      busy = true;
      try {
        await db.connect();
        await db.query("BEGIN READ ONLY");
        await assertInventoryRole(db);
        await db.query("SET LOCAL ROLE berth_inventory_reader");
        return await retainedInventoryLedger(db).page(after, limit);
      } finally {
        try {
          await db.end();
        } finally {
          busy = false;
        }
      }
    },
  };
}

/** Read one offering page through a connection granted only Inventory reader capability. */
export function retainedInventoryLedger(
  db: RetainedTrialDatabase,
): InventoryReader {
  return {
    /** Use the existing bounded SQL projection. The cursor remains opaque to the caller. */
    async page(
      after: string | null = null,
      limit = 20,
    ): Promise<InventoryPage> {
      return decodeInventoryPage(
        await retainedTrialResult(
          db,
          "SELECT berth_inventory.inventory_page($1,$2) AS result",
          [after, limit],
        ),
      );
    },
  };
}
