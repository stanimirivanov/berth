/** Validate both injected URLs and reject unrelated service credentials before connecting. */
export function restrictedConnection(env: Record<string, string | undefined>) {
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
  return connection;
}
/**
 * Fail closed before ledger access if the dedicated login has gained administrator,
 * ownership, role-switching, schema creation or protected-table privileges. This is
 * a startup drift check, not protection against a concurrent malicious DB owner.
 */
export async function assertExecutorPrivileges(db: {
  query(text: string): Promise<{ rows: Record<string, unknown>[] }>;
}) {
  try {
    const result = await db.query(`SELECT current_user='berth_runtime'
      AND session_user='berth_runtime' AND current_database()='neondb'
      AND r.rolcanlogin AND NOT (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole
        OR r.rolreplication OR r.rolbypassrls OR r.rolinherit)
      AND NOT EXISTS (SELECT FROM pg_auth_members WHERE member=r.oid)
      AND NOT EXISTS (SELECT FROM pg_database WHERE datdba=r.oid)
      AND NOT EXISTS (SELECT FROM pg_namespace WHERE nspowner=r.oid)
      AND NOT EXISTS (SELECT FROM pg_class WHERE relowner=r.oid)
      AND NOT EXISTS (SELECT FROM pg_proc WHERE proowner=r.oid)
      AND NOT has_database_privilege(r.oid,current_database(),'CREATE,TEMP')
      AND NOT EXISTS (SELECT FROM pg_namespace n WHERE n.nspname NOT LIKE 'pg_temp%'
        AND has_schema_privilege(r.oid,n.oid,'CREATE'))
      AND NOT EXISTS (SELECT FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname IN ('berth_ledger','berth_executor','berth_usage')
        AND (has_table_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
          OR has_any_column_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE,REFERENCES')))
      AS restricted FROM pg_roles r WHERE r.rolname=current_user`);
    if (result.rows.length !== 1 || result.rows[0]?.restricted !== true)
      throw Error("Rejected");
  } catch {
    throw Error("Runtime privilege boundary failed");
  }
}
