import { type Client, escapeIdentifier, escapeLiteral } from "pg";

export class SetupError extends Error {}

export interface DatabaseTarget {
  database: string;
  owner: string;
  role: string;
  schema: string;
}

// This bootstrap is deliberately restricted to a fresh, dedicated trial database.
// Existing roles/schemas are never adopted, repaired or given a new password.
export async function prepareDatabase(
  db: Client,
  target: DatabaseTarget,
  password: string,
): Promise<void> {
  const r = escapeIdentifier(target.role);
  const s = escapeIdentifier(target.schema);
  const d = escapeIdentifier(target.database);
  await db.query("BEGIN");
  try {
    await db.query("SELECT pg_advisory_xact_lock(20261112, 3)");
    const existing = await db.query(
      `SELECT EXISTS (SELECT FROM pg_roles WHERE rolname = $1)
        OR EXISTS (SELECT FROM pg_namespace WHERE nspname = $2)
        OR EXISTS (SELECT FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
          AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp%'
          AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
          AND NOT EXISTS (SELECT FROM pg_depend x WHERE x.classid = 'pg_class'::regclass
            AND x.objid = c.oid AND x.deptype = 'e'))
        OR EXISTS (SELECT FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
          AND NOT EXISTS (SELECT FROM pg_depend x WHERE x.classid = 'pg_proc'::regclass
            AND x.objid = p.oid AND x.deptype = 'e'))
        OR EXISTS (SELECT FROM pg_database WHERE NOT datistemplate
          AND datname NOT IN (current_database(), 'postgres')) AS occupied`,
      [target.role, target.schema],
    );
    if (existing.rows[0]?.occupied !== false)
      throw new SetupError("Database is not fresh");
    // PostgreSQL utility statements do not accept bind parameters for identifiers
    // or role passwords. pg's quoting functions encode both; nothing is logged.
    await db.query(`CREATE ROLE ${r} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB
      NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD ${escapeLiteral(password)}`);
    await db.query(`REVOKE CREATE, TEMPORARY ON DATABASE ${d} FROM PUBLIC`);
    await db.query("REVOKE CREATE ON SCHEMA public FROM PUBLIC");
    await db.query(`GRANT CONNECT ON DATABASE ${d} TO ${r}`);
    await db.query(
      `CREATE SCHEMA ${s} AUTHORIZATION ${escapeIdentifier(target.owner)}`,
    );
    await db.query(`REVOKE ALL ON SCHEMA ${s} FROM PUBLIC`);
    await db.query(`GRANT USAGE ON SCHEMA ${s} TO ${r}`);
    await db.query(
      `CREATE TABLE ${s}.permission_probe (id integer PRIMARY KEY, value text NOT NULL)`,
    );
    await db.query(`CREATE TABLE ${s}.denied_probe (id integer PRIMARY KEY)`);
    await db.query(`REVOKE ALL ON ALL TABLES IN SCHEMA ${s} FROM PUBLIC`);
    await db.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ${s}.permission_probe TO ${r}`,
    );
    // Verify grants before committing, while all changes can still roll back.
    await verifyPrivileges(db, target);
    await db.query("COMMIT");
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  }
}

export async function verifyPrivileges(
  db: Client,
  target: DatabaseTarget,
): Promise<void> {
  const result = await db.query(
    `SELECT r.rolcanlogin AND NOT (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole
        OR r.rolreplication OR r.rolbypassrls OR r.rolinherit)
      AND NOT EXISTS (SELECT FROM pg_auth_members WHERE member = r.oid)
      AND NOT EXISTS (SELECT FROM pg_database WHERE datdba = r.oid)
      AND NOT EXISTS (SELECT FROM pg_namespace WHERE nspowner = r.oid)
      AND NOT EXISTS (SELECT FROM pg_class WHERE relowner = r.oid)
      AND NOT EXISTS (SELECT FROM pg_proc WHERE proowner = r.oid)
      AND NOT has_database_privilege(r.oid, current_database(), 'CREATE')
      AND NOT has_database_privilege(r.oid, current_database(), 'TEMP')
      AND NOT EXISTS (SELECT FROM pg_namespace n
        WHERE n.nspname NOT LIKE 'pg_temp%' AND has_schema_privilege(r.oid, n.oid, 'CREATE'))
      AND NOT EXISTS (SELECT FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
          AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp%'
          AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
          AND NOT (n.nspname = $2 AND c.relname = 'permission_probe')
          AND NOT EXISTS (SELECT FROM pg_depend x WHERE x.classid = 'pg_class'::regclass
            AND x.objid = c.oid AND x.deptype = 'e')
          AND has_table_privilege(r.oid, c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'))
      AS restricted FROM pg_roles r WHERE r.rolname = $1`,
    [target.role, target.schema],
  );
  if (result.rows.length !== 1 || result.rows[0]?.restricted !== true) {
    throw new SetupError("Runtime privilege boundary failed");
  }
}

export async function verifyRuntime(
  db: Client,
  target: DatabaseTarget,
): Promise<void> {
  const identity = await db.query("SELECT current_user, current_database()");
  if (
    identity.rows[0]?.current_user !== target.role ||
    identity.rows[0]?.current_database !== target.database
  )
    throw new SetupError("Wrong runtime identity");
  await verifyPrivileges(db, target);
  const s = escapeIdentifier(target.schema);
  await db.query("BEGIN");
  try {
    await db.query(`INSERT INTO ${s}.permission_probe VALUES (1, 'initial')`);
    await db.query(
      `UPDATE ${s}.permission_probe SET value = 'verified' WHERE id = 1`,
    );
    const read = await db.query(
      `SELECT value FROM ${s}.permission_probe WHERE id = 1`,
    );
    if (read.rows[0]?.value !== "verified")
      throw new SetupError("Runtime CRUD failed");
    const deleted = await db.query(
      `DELETE FROM ${s}.permission_probe WHERE id = 1`,
    );
    if (deleted.rowCount !== 1) throw new SetupError("Runtime delete failed");
    for (const sql of [
      `CREATE TABLE ${s}.forbidden_probe (id integer)`,
      "CREATE TEMP TABLE forbidden_probe (id integer)",
      "CREATE SCHEMA berth_forbidden_probe",
      "CREATE ROLE berth_forbidden_probe",
      `ALTER TABLE ${s}.permission_probe ADD COLUMN forbidden integer`,
      `SELECT * FROM ${s}.denied_probe`,
      `SET ROLE ${escapeIdentifier(target.owner)}`,
    ]) {
      await db.query("SAVEPOINT permission_denial");
      let denied = false;
      try {
        await db.query(sql);
      } catch (error) {
        denied =
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "42501";
      }
      await db.query("ROLLBACK TO SAVEPOINT permission_denial");
      if (!denied)
        throw new SetupError("Expected privilege denial was not established");
    }
  } finally {
    // Probes leave no rows or unexpected DDL, including when a denial fails.
    await db.query("ROLLBACK");
  }
}
