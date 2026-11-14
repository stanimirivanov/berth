import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { NoRetryConfigurationDetails } from "oci-common";
import { Client } from "pg";
import type { ObjectSdk } from "../../src/providers/oci/client.js";
import { runExecutor } from "../../src/trial/executor.js";
import { executorStore } from "../../src/trial/executor-store.js";
import { mutations, sdkMethods, writeBoundary } from "./faults.js";

const [configFile] = process.argv.slice(2);
if (!configFile) throw Error("Fixture config missing");
const config = JSON.parse(readFileSync(configFile, "utf8"));
if (
  !Number.isInteger(config.port) ||
  config.port < 1 ||
  config.port > 65535 ||
  !/^http:\/\/127\.0\.0\.1:\d+$/.test(config.cloud)
)
  throw Error("Loopback fixture required");
let fixtureFailure = false;
let occurrence = 0,
  clockOffset = 0;
const occurrences = new Map<string, number>();
/** SIGKILL deliberately bypasses finally; trace is flushed before the process dies. */
function point(label: string) {
  const n = (occurrences.get(label) ?? 0) + 1;
  occurrences.set(label, n);
  appendFileSync(config.trace, `${JSON.stringify({ label, occurrence: n })}\n`);
  occurrence++;
  if (config.fault?.label === label && config.fault?.occurrence === n)
    process.kill(process.pid, "SIGKILL");
}
const db = new Client({
  host: "127.0.0.1",
  port: config.port,
  database: "neondb",
  user: "berth_runtime",
  password: "test-runtime-only",
  connectionTimeoutMillis: 3000,
  statement_timeout: 5000,
});
const actions = new Map<string, string>(),
  requests = new Map<string, string>();
let reservation = { id: "", action: "", generation: "" };
const wrapped = {
  async query(sql: string, values: unknown[] = []) {
    const action = sql.includes("settle")
      ? (requests.get(String(values[3])) ?? "")
      : (actions.get(String(values[3] === "end" ? values[4] : values[3])) ??
        "");
    let label: string | null;
    try {
      label = writeBoundary(sql, values, action);
    } catch {
      fixtureFailure = true;
      throw Error("Unclassified fixture SQL");
    }
    if (label) point(`before:${label}`);
    const result = await db.query(sql, values);
    if (sql.includes("begin_attempt"))
      actions.set(String(result.rows[0]?.result), String(values[4]));
    if (sql.includes("berth_ledger.reserve")) {
      reservation = {
        id: String(values[4]),
        action: actions.get(String(values[3])) ?? "",
        generation: String(values[2]),
      };
      requests.set(reservation.id, reservation.action);
      if (config.expireAfterReserve && reservation.action === "create_bucket")
        clockOffset = 1800001;
    }
    if (sql.includes("berth_ledger.control") && values[3] === "read") {
      const j = result.rows[0]?.result;
      for (const a of j.attempts) actions.set(a.id, a.action);
      for (const r of j.requests)
        requests.set(r.id, actions.get(r.attempt) ?? "");
    }
    if (label) point(`after:${label}`);
    return result;
  },
};
const sdk = new Proxy({ endpoint: "" } as ObjectSdk, {
  get(target, key) {
    if (!sdkMethods.includes(key as (typeof sdkMethods)[number]))
      return Reflect.get(target, key);
    return async (input: Record<string, unknown>) => {
      const name = String(key);
      if (mutations.has(name)) point(`before:cloud.${name}`);
      const response = await fetch(config.cloud, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          method: name,
          input: {
            ...input,
            putObjectBody:
              input.putObjectBody instanceof Uint8Array
                ? Buffer.from(input.putObjectBody).toString("base64")
                : undefined,
            retryConfiguration: undefined,
          },
          noRetry: input.retryConfiguration === NoRetryConfigurationDetails,
          reservation,
        }),
        signal: AbortSignal.timeout(45000),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw { statusCode: response.status };
      }
      const result = await response.json();
      if (mutations.has(name)) point(`after:cloud.${name}`);
      if (name === "getObject")
        result.value = new ReadableStream({
          start(c) {
            c.enqueue(Buffer.from(result.bytes, "base64"));
            c.close();
          },
        });
      return result;
    };
  },
});
try {
  await db.connect();
  const result = config.cancel
    ? await executorStore(wrapped).cleanup(config.operation)
    : await runExecutor(wrapped, {
        operation: config.operation,
        delivery: config.delivery,
        expiresAt: config.expiresAt,
        now: () => Date.now() + clockOffset,
        sdk: () => sdk,
        ...(config.usage
          ? {
              usage: async () => {
                const response = await fetch(config.cloud, {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({
                    method: "monitor",
                    input: {},
                    noRetry: true,
                    reservation,
                  }),
                  signal: AbortSignal.timeout(5000),
                });
                if (!response.ok) throw Error("Fixture monitoring failed");
                return response.json();
              },
            }
          : {}),
      });
  if (fixtureFailure) throw Error("Fixture classification failed");
  writeFileSync(
    config.result,
    JSON.stringify({ result, checkpoints: occurrence }),
  );
} catch {
  process.exitCode = 1;
  writeFileSync(
    config.result,
    JSON.stringify({ result: { phase: "thrown" }, checkpoints: occurrence }),
  );
} finally {
  await db.end();
}
