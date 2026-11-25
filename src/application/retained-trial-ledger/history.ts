import { Client, type ClientConfig } from "pg";
import {
  assertRuntimePrivileges,
  restrictedConnection,
} from "../../storage/postgres/runtime-access.ts";
import {
  decodeHistoryDetail,
  decodeHistoryPage,
  type HistoryRead,
} from "../history/contract.ts";
import { type RetainedTrialDatabase, retainedTrialResult } from "./sql.ts";

/** Hold the restricted client inside the adapter for one History invocation. */
interface HistoryDatabase extends RetainedTrialDatabase {
  connect(): Promise<unknown>;
  end(): Promise<unknown>;
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
  database: (configuration: ClientConfig) => HistoryDatabase = (
    configuration,
  ) => new Client(configuration),
): HistoryRead {
  let busy = false;

  /** Keep each read inside one checked transaction and release it before the next read. */
  async function withLedger<T>(read: (ledger: HistoryRead) => Promise<T>) {
    if (
      busy ||
      Object.keys(env).some((key) => key.startsWith("OCI_") && env[key])
    )
      throw Error("History unavailable");
    const db = database({
      connectionString: restrictedConnection(env),
      connectionTimeoutMillis: 3000,
      query_timeout: 5000,
      statement_timeout: 2000,
      ssl: { rejectUnauthorized: true },
    });
    busy = true;
    try {
      await db.connect();
      await db.query("BEGIN READ ONLY");
      await assertRuntimePrivileges(db);
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
