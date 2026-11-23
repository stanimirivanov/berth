import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import {
  DefaultRequestSigner,
  SimpleAuthenticationDetailsProvider,
} from "oci-common";
import { Client, type ClientConfig } from "pg";
import {
  type RetryObserver,
  retryObserver,
} from "../providers/oci/retry-observation.js";
import type { RetryAction } from "./retry-api.js";
import { type RetryDatabase, retryActions } from "./retry-reconciliation.js";

/** Server-only configuration for owner sign-in and separately scoped credentials. */
type Environment = Record<string, string | undefined>;

/** A checked connection is opened per authenticated request. */
export interface RetryConnection extends RetryDatabase {
  connect(): Promise<unknown>;
  end(): Promise<unknown>;
}

/** Construct a strict TLS connection for the separate retry login. URL options cannot override TLS. */
function connection(env: Environment): ClientConfig {
  const url = new URL(env.BERTH_RETRY_DATABASE_URL ?? "");
  if (
    url.protocol !== "postgresql:" ||
    url.username !== "berth_retry_runtime" ||
    !url.password ||
    url.pathname !== "/neondb" ||
    url.hash ||
    (url.port && url.port !== "5432") ||
    !/^ep-[a-z0-9-]+\.[a-z0-9.-]+\.neon\.tech$/.test(url.hostname) ||
    [...url.searchParams].some(
      ([key, value]) =>
        url.searchParams.getAll(key).length !== 1 ||
        !(
          (key === "sslmode" && ["require", "verify-full"].includes(value)) ||
          (key === "channel_binding" && value === "require")
        ),
    )
  )
    throw Error("Retry database unavailable");
  return {
    host: url.hostname,
    port: 5432,
    database: "neondb",
    user: url.username,
    password: decodeURIComponent(url.password),
    ssl: { rejectUnauthorized: true },
    enableChannelBinding: true,
    connectionTimeoutMillis: 3000,
    statement_timeout: 2500,
    query_timeout: 4000,
  };
}

/** Reject broad grants or a different login before a hosted action can use SQL. */
async function assertRole(db: RetryDatabase) {
  const result = await db.query(
    `SELECT
    current_user = 'berth_retry_runtime' AND session_user = current_user
    AND current_database() = 'neondb' AND r.rolcanlogin
    AND NOT (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls)
    AND pg_has_role(r.oid,'berth_retry_action','USAGE')
    AND NOT EXISTS (
      SELECT FROM pg_auth_members m JOIN pg_roles parent ON parent.oid=m.roleid
      WHERE (m.member = r.oid AND (parent.rolname <> 'berth_retry_action' OR m.admin_option))
        OR (m.member = to_regrole('berth_retry_action')::oid)
    )
    AND NOT has_database_privilege(r.oid,current_database(),'CREATE,TEMP')
    AND NOT EXISTS (SELECT FROM pg_namespace n WHERE has_schema_privilege(r.oid,n.oid,'CREATE'))
    AND NOT EXISTS (
      SELECT FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE starts_with(n.nspname::text,'berth_')
        AND c.relkind IN ('r','v','m','f','p')
        AND (has_table_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
          OR has_any_column_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE,REFERENCES'))
    )
    AND NOT EXISTS (
      SELECT FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE (starts_with(n.nspname::text,'berth_') AND n.nspname <> 'berth_retry')
        AND has_function_privilege(r.oid,p.oid,'EXECUTE')
    )
    AND NOT EXISTS (
      SELECT FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname = 'berth_retry' AND has_function_privilege(r.oid,p.oid,'EXECUTE')
        AND p.oid NOT IN (
          'berth_retry.status(uuid)'::regprocedure, 'berth_retry.begin(uuid,uuid)'::regprocedure,
          'berth_retry.reserve(uuid,uuid,text)'::regprocedure,
          'berth_retry.finish(uuid,uuid,jsonb)'::regprocedure
        )
    ) AS allowed
    FROM pg_roles r WHERE r.rolname=current_user`,
    [],
  );
  if (result.rows[0]?.allowed !== true)
    throw Error("Retry database unavailable");
}

/** Build only the fixed OCI read observer. No ambient provider credentials or executor port are accepted. */
function observer(env: Environment): RetryObserver {
  const region = env.BERTH_RETRY_OCI_REGION ?? "";
  const namespace = env.BERTH_RETRY_OCI_NAMESPACE ?? "";
  const compartment = env.BERTH_RETRY_OCI_COMPARTMENT ?? "";
  const tenancy = env.BERTH_RETRY_OCI_TENANCY ?? "";
  const user = env.BERTH_RETRY_OCI_USER ?? "";
  const pem = env.BERTH_RETRY_OCI_KEY ?? "";
  if (
    !/^ocid1[.]tenancy[.]oc1[.][.][A-Za-z0-9]{1,128}$/.test(tenancy) ||
    !/^ocid1[.]user[.]oc1[.][.][A-Za-z0-9]{1,128}$/.test(user) ||
    !pem ||
    pem.length > 8192
  )
    throw Error("Retry observer unavailable");
  const key = createPrivateKey(pem);
  if (
    key.asymmetricKeyType !== "rsa" ||
    (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048
  )
    throw Error("Retry observer unavailable");
  // OCI identifies its public key using the DER fingerprint, independent of session signing.
  const fingerprint = createHash("md5")
    .update(createPublicKey(key).export({ type: "spki", format: "der" }))
    .digest("hex")
    .match(/../g)
    ?.join(":");
  if (!fingerprint || fingerprint !== env.BERTH_RETRY_OCI_FINGERPRINT)
    throw Error("Retry observer unavailable");
  return retryObserver(
    { region, namespace, compartment },
    new DefaultRequestSigner(
      new SimpleAuthenticationDetailsProvider(
        tenancy,
        user,
        fingerprint,
        pem,
        null,
      ),
    ),
  );
}

/** Status and missing read credentials never load a working provider transport. */
const unavailable: RetryObserver = {
  /** Deny before reserving a provider request. */
  supports: () => false,
  /** A missing read prerequisite never touches OCI. */
  observe: async () => ({ kind: "inconclusive" }),
};

/** Open one checked connection after owner authentication, and release it on every outcome. */
export function retryRuntime(
  env: Environment,
  database: (config: ClientConfig) => RetryConnection = (config) =>
    new Client(config),
): RetryAction {
  return async (action, operation) => {
    const db = database(connection(env));
    try {
      await db.connect();
      await assertRole(db);
      let provider = unavailable;
      if (action === "start") {
        try {
          provider = observer(env);
        } catch {
          // Preserve a durable read-scope stop even when OCI credentials are unavailable.
        }
      }
      return await retryActions(db, provider)(action, operation);
    } finally {
      await db.end();
    }
  };
}
