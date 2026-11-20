import { Client, type ClientConfig } from "pg";
import {
  assertExecutorPrivileges,
  restrictedConnection,
} from "./executor-security.js";
import { executorStore } from "./executor-store.js";
import type { HistoryRead } from "./history-api.js";

/** Restricted invocation connection; tests replace only the database I/O boundary. */
export interface HistoryDatabase {
  /** Open one bounded connection after HTTP authentication. */
  connect(): Promise<unknown>;
  /** Parameterized SQL only; the service starts a read-only transaction. */
  query(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }>;
  /** Release the connection and roll back its read-only transaction. */
  end(): Promise<unknown>;
}

/** Separate read service: no OCI credentials, execution ports, migrations or retry loops. */
export function historyReader(
  env: Record<string, string | undefined>,
  database: (configuration: ClientConfig) => HistoryDatabase = (
    configuration,
  ) => new Client(configuration),
): HistoryRead {
  let busy = false;
  return async (operation, before, limit) => {
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
      await assertExecutorPrivileges(db);
      const store = executorStore(db);
      return operation
        ? await store.historyDetail(operation)
        : await store.history(before, limit);
    } finally {
      try {
        await db.end();
      } finally {
        busy = false;
      }
    }
  };
}
