import {
  decodeApproval,
  decodeContinuation,
  type RetryContinuation,
} from "../retry/continuation.ts";
import {
  decodeRetryClaim,
  decodeRetryReservation,
  decodeRetryStatus,
  type RetryLedger,
} from "../retry/contract.ts";
import {
  type HostedPostgresConfig,
  hostedPostgresClient,
} from "./hosted-postgres.ts";
import { type RetainedTrialDatabase, retainedTrialResult } from "./sql.ts";

/** A checked connection is opened per authenticated retry request. */
interface RetryConnection extends RetainedTrialDatabase {
  connect(): Promise<unknown>;
  end(): Promise<unknown>;
}

/** Environment for the separately scoped Retry database login. */
type Environment = Record<string, string | undefined>;

/** Run work with checked Retry operations for the duration of one invocation. */
export type RetainedRetrySession = <T>(
  work: (operations: {
    ledger: RetryLedger;
    continuation: RetryContinuation;
  }) => Promise<T>,
) => Promise<T>;

/** Construct a strict TLS connection for the separate retry login. URL options cannot override TLS. */
function connection(env: Environment): HostedPostgresConfig {
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
    requireChannelBinding: url.searchParams.has("channel_binding"),
    connectionTimeoutMillis: 3000,
    statement_timeout: 2500,
    query_timeout: 4000,
  };
}

/** Bind the Retry interface to its four guarded SQL routines, using only the retry login. */
function retainedRetryLedger(db: RetainedTrialDatabase): RetryLedger {
  return {
    /** Status never starts work. */
    async status(operation) {
      return decodeRetryStatus(
        await retainedTrialResult(
          db,
          "SELECT berth_retry.status($1) AS result",
          [operation],
        ),
      );
    },
    /** A duplicate returns retained status rather than a fresh claim. */
    async begin(operation, claim) {
      return decodeRetryClaim(
        await retainedTrialResult(
          db,
          "SELECT berth_retry.begin($1,$2) AS result",
          [operation, claim],
        ),
      );
    },
    /** Decode the committed reservation before the caller can send the GET. */
    async reserve(operation, claim, probe) {
      return decodeRetryReservation(
        await retainedTrialResult(
          db,
          "SELECT berth_retry.reserve($1,$2,$3) AS result",
          [operation, claim, probe],
        ),
      );
    },
    /** Persist normalized observations through the existing owner-installed evidence policy. */
    async finish(operation, claim, proof) {
      return decodeRetryStatus(
        await retainedTrialResult(
          db,
          "SELECT berth_retry.finish($1,$2,$3::jsonb) AS result",
          [operation, claim, JSON.stringify(proof)],
        ),
      );
    },
  };
}

/** Project retained continuation status or atomically record a specified approval. */
function retainedRetryContinuation(
  db: RetainedTrialDatabase,
): RetryContinuation {
  return async (operation, proposal) =>
    proposal === null
      ? decodeContinuation(
          await retainedTrialResult(
            db,
            "SELECT berth_retry.continuation_status($1) AS result",
            [operation],
          ),
        )
      : decodeApproval(
          await retainedTrialResult(
            db,
            "SELECT berth_retry.approve_continuation($1,$2) AS result",
            [operation, proposal],
          ),
        );
}

/** Reject broad grants or a different login before a hosted action can use SQL. */
async function assertRetainedRetryRole(db: RetainedTrialDatabase) {
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
        AND NOT EXISTS (
          SELECT FROM unnest(ARRAY[
            to_regprocedure('berth_retry.status(uuid)'),
            to_regprocedure('berth_retry.begin(uuid,uuid)'),
            to_regprocedure('berth_retry.reserve(uuid,uuid,text)'),
            to_regprocedure('berth_retry.finish(uuid,uuid,jsonb)'),
            to_regprocedure('berth_retry.continuation_status(uuid)'),
            to_regprocedure('berth_retry.approve_continuation(uuid,uuid)')
          ]) AS allowed(oid) WHERE allowed.oid = p.oid
        )
    ) AS allowed
    FROM pg_roles r WHERE r.rolname=current_user`,
    [],
  );
  if (result.rows[0]?.allowed !== true)
    throw Error("Retry database unavailable");
}

/** Own the client and role check for each Retry invocation, including failed work. */
export function retainedRetrySession(
  env: Environment,
  database: (
    config: HostedPostgresConfig,
  ) => RetryConnection = hostedPostgresClient,
): RetainedRetrySession {
  return async (work) => {
    const db = database(connection(env));
    try {
      await db.connect();
      await assertRetainedRetryRole(db);
      return await work({
        ledger: retainedRetryLedger(db),
        continuation: retainedRetryContinuation(db),
      });
    } finally {
      await db.end();
    }
  };
}
