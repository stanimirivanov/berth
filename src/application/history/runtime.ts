import { Client, type ClientConfig } from "pg";
import {
  prepareRetainedHistoryReader,
  retainedHistoryConnection,
  retainedHistoryLedger,
} from "../retained-trial-ledger/history.ts";
import type { HistoryRead } from "./contract.ts";

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

  /** Keep each read inside one checked transaction and release it before the next read. */
  async function withLedger<T>(read: (ledger: HistoryRead) => Promise<T>) {
    if (
      busy ||
      Object.keys(env).some((key) => key.startsWith("OCI_") && env[key])
    )
      throw Error("History unavailable");
    const db = database({
      connectionString: retainedHistoryConnection(env),
      connectionTimeoutMillis: 3000,
      query_timeout: 5000,
      statement_timeout: 2000,
      ssl: { rejectUnauthorized: true },
    });
    busy = true;
    try {
      await db.connect();
      await prepareRetainedHistoryReader(db);
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
