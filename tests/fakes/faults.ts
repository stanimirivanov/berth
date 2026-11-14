import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { NoRetryConfigurationDetails } from "oci-common";
import type { Client } from "pg";
import { FakeObjects } from "./oci.js";
/** Stable semantic SQL boundary; values, identities and provider bodies never become labels. */
export function writeBoundary(sql: string, values: unknown[], action = "") {
  if (sql.includes("berth_executor.open")) return "executor.open";
  if (sql.includes("berth_executor.cleanup")) return "executor.cleanup";
  if (sql.includes("berth_executor.access")) {
    const command = String(values[3]);
    if (["get-state", "snapshot"].includes(command)) return null;
    let suffix = "";
    if (command === "set-state")
      suffix = `:${JSON.parse(String(values[4])).status}`;
    if (command === "phase") suffix = `:${JSON.parse(String(values[4]))}`;
    return `executor.${command}${suffix}`;
  }
  if (sql.includes("berth_usage.control"))
    return values[3] === "allowed" ? null : `usage.${values[3]}`;
  if (sql.includes("berth_ledger.begin_attempt"))
    return `ledger.begin:${values[4]}`;
  if (sql.includes("berth_ledger.reserve")) return `ledger.reserve:${action}`;
  if (sql.includes("berth_ledger.settle"))
    return `ledger.settle:${action}:${values[4]}:${values[5]}`;
  if (sql.includes("berth_ledger.control"))
    return values[3] === "read"
      ? null
      : `ledger.${values[3]}${values[3] === "end" ? `:${action}` : ""}${values[5] ? `:${values[5]}` : ""}`;
  throw Error("Unclassified SQL boundary");
}
/** Explicit SDK surface; fixture HTTP cannot invoke arbitrary object methods. */
export const sdkMethods = [
  "listBuckets",
  "getBucket",
  "createBucket",
  "deleteBucket",
  "listRetentionRules",
  "listObjects",
  "listMultipartUploads",
  "listPreauthenticatedRequests",
  "listObjectVersions",
  "putObject",
  "headObject",
  "getObject",
  "deleteObject",
] as const;
/** Mutations are committed in the independent service before an executor sees success. */
export const mutations = new Set<string>([
  "createBucket",
  "putObject",
  "deleteObject",
  "deleteBucket",
]);
/** Independent loopback provider survives SIGKILL of its clients, including pending late responses. */
export async function cloudService(
  owner: Client,
  loss?: string,
  delayCreate = false,
) {
  const sdk = new FakeObjects(),
    received: {
      id: string;
      method: string;
      action: string;
      generation: string;
    }[] = [],
    violations: string[] = [];
  let release = () => {},
    accepted = () => {};
  const gate = new Promise<void>((r) => {
      release = r;
    }),
    pending = new Promise<void>((r) => {
      accepted = r;
    });
  let lost = false,
    delayed = false;
  const server = createServer(async (req, res) => {
    try {
      let body = "";
      for await (const chunk of req) {
        body += String(chunk);
        if (body.length > 1500000) throw Error("Fixture input bound");
      }
      const p = JSON.parse(body);
      if (p.method !== "monitor" && !sdkMethods.includes(p.method))
        throw Error("Fixture method");
      const row = (
        await owner.query(
          "SELECT r.*,a.action FROM berth_ledger.requests r JOIN berth_ledger.attempts a ON a.id=r.attempt WHERE r.id=$1",
          [p.reservation.id],
        )
      ).rows[0];
      assert.ok(row, "dispatch lacked committed reservation");
      assert.equal(row.outcome, "unresolved");
      assert.equal(String(row.generation), p.reservation.generation);
      assert.equal(row.action, p.reservation.action);
      assert.ok(
        !received.some((x) => x.id === row.id),
        "reservation dispatched twice",
      );
      const expected: Record<string, string> = {
        createBucket: "create_bucket",
        putObject: "put_object",
        deleteObject: "delete_object",
        deleteBucket: "delete_bucket",
        monitor: "monitor",
      };
      if (expected[p.method]) assert.equal(row.action, expected[p.method]);
      else assert.ok(["inspect", "inspect_cleanup"].includes(row.action));
      assert.equal(
        row.meter,
        row.action === "monitor"
          ? "monitoring"
          : row.action === "inspect_cleanup" || row.action.startsWith("delete_")
            ? "cleanup"
            : "normal",
      );
      assert.equal(p.noRetry, true);
      received.push({
        id: row.id,
        method: p.method,
        action: row.action,
        generation: String(row.generation),
      });
      if (p.method === "createBucket" && delayCreate && !delayed) {
        delayed = true;
        accepted();
        await gate;
      }
      if (loss === `reject:${p.method}` && !lost) {
        lost = true;
        res.writeHead(400);
        res.end(JSON.stringify({ message: "private-canary" }));
        return;
      }
      const input = {
        ...p.input,
        retryConfiguration: NoRetryConfigurationDetails,
      };
      if (p.method === "putObject") {
        assert.equal(typeof input.putObjectBody, "string");
        input.putObjectBody = Buffer.from(input.putObjectBody, "base64");
        assert.equal(input.putObjectBody.length, 1048576);
      }
      const method = Reflect.get(sdk, p.method) as (
        arg: unknown,
      ) => Promise<Record<string, unknown>>;
      const result =
        p.method === "monitor" ? [] : await method.call(sdk, input);
      if (p.method === loss && !lost) {
        lost = true;
        res.writeHead(500);
        res.end(JSON.stringify({ message: "private-canary" }));
        return;
      }
      let response = result;
      if (p.method === "getObject") {
        const reader = (
          (result as Record<string, unknown>)
            .value as ReadableStream<Uint8Array>
        ).getReader();
        const chunks: Uint8Array[] = [];
        let length = 0;
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          length += next.value.length;
          assert.ok(length <= 1048576);
          chunks.push(next.value);
        }
        response = {
          ...result,
          value: null,
          bytes: Buffer.concat(chunks).toString("base64"),
        };
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(response));
    } catch (e) {
      const status =
        e && typeof e === "object" && "statusCode" in e
          ? Number(e.statusCode)
          : 500;
      if (e instanceof assert.AssertionError) violations.push(e.message);
      else if (!(e && typeof e === "object" && "statusCode" in e))
        violations.push("Unexpected fixture failure");
      res.writeHead(status);
      res.end(JSON.stringify({ message: "private-canary" }));
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    sdk,
    received,
    violations,
    pending,
    release,
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    async close() {
      release();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

/** Checkpoint-specific oracle: generic exceptions or new recovery stalls cannot count as safe convergence. */
export function classifyRecovery(
  label: string,
  row: {
    outcome: string;
    unknown: number;
    cleanup_used: number;
    failed: boolean;
    reason: string | null;
  },
) {
  const uncertain = new Set([
    "after:ledger.reserve:create_bucket",
    "before:cloud.createBucket",
    "after:ledger.reserve:put_object",
    "before:cloud.putObject",
    "after:ledger.reserve:delete_object",
    "before:cloud.deleteObject",
    "after:ledger.reserve:delete_bucket",
    "before:cloud.deleteBucket",
    "before:ledger.settle:create_bucket:rejected:provider-response",
    "before:ledger.settle:put_object:rejected:provider-response",
  ]);
  const cleanupBlocked = new Set([
    "before:ledger.begin:delete_object",
    "after:ledger.begin:delete_object",
    "before:ledger.reserve:delete_object",
  ]);
  if (uncertain.has(label) || cleanupBlocked.has(label)) {
    assert.equal(row.outcome, "needs-reconciliation", label);
    assert.equal(row.failed, true, label);
    assert.equal(row.reason, "unresolved-provider-call", label);
    assert.equal(row.unknown, uncertain.has(label) ? 1 : 0, label);
    if (cleanupBlocked.has(label)) assert.equal(row.cleanup_used, 40, label);
    return uncertain.has(label) ? "uncertain" : "cleanup-blocked";
  }
  assert.ok(
    ["succeeded", "failed"].includes(row.outcome),
    `unexpected recovery stop: ${label}`,
  );
  assert.equal(row.unknown, 0, label);
  return "terminal";
}
