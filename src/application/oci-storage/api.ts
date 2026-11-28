import { createHash, timingSafeEqual } from "node:crypto";
import { boundedJson } from "../../http/bounded-json.ts";
import type { StorageCollector, StorageRepository } from "./contract.ts";

const tokenShape = /^[A-Za-z0-9_-]{32,128}$/;

/** Verify the native schedule delivery and reject outdated, excess or malformed input. */
async function scheduledAt(
  request: Request,
  invocation: string,
  triggerId: string,
  now: number,
) {
  const value = await boundedJson(
    request.body,
    AbortSignal.timeout(1000),
    4096,
  );
  if (
    value === null ||
    typeof value !== "object" ||
    !("version" in value) ||
    value.version !== 1 ||
    !("invocation_id" in value) ||
    value.invocation_id !== invocation ||
    !("trigger" in value) ||
    !value.trigger ||
    typeof value.trigger !== "object" ||
    !("type" in value.trigger) ||
    value.trigger.type !== "schedule" ||
    !("id" in value.trigger) ||
    typeof value.trigger.id !== "string" ||
    value.trigger.id !== triggerId ||
    !("data" in value) ||
    !value.data ||
    typeof value.data !== "object" ||
    !("scheduled_at" in value.data) ||
    typeof value.data.scheduled_at !== "string"
  )
    throw Error("Invalid schedule delivery");
  const stamp = Date.parse(value.data.scheduled_at);
  if (!Number.isFinite(stamp) || stamp > now || now - stamp > 300_000)
    throw Error("Outdated schedule delivery");
  return new Date(stamp).toISOString();
}

/** Owner reads use saved data. Only authenticated Neon deliveries can claim a refresh slot. */
export function ociStorageApi(
  token: string,
  repository: StorageRepository,
  collect: StorageCollector,
  triggerId: string,
  clock: () => number = Date.now,
) {
  const digest = (value: string) => createHash("sha256").update(value).digest();
  const expected = digest(`Bearer ${token}`);
  /** Keep snapshots and their fixed diagnostics out of intermediary caches. */
  const reply = (
    value: unknown,
    status = 200,
    headers: Record<string, string> = {},
  ) =>
    Response.json(value, {
      status,
      headers: {
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        ...headers,
      },
    });
  const unavailable = () => reply({ error: "oci-storage-unavailable" }, 503);
  return {
    /** Authenticate before opening storage or loading signing material. */
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      if (url.search)
        return reply({ error: "invalid-oci-storage-request" }, 400);
      if (url.pathname === "/api/inventory/oci-storage") {
        if (request.method !== "GET")
          return reply({ error: "method-not-allowed" }, 405, { allow: "GET" });
        if (!tokenShape.test(token)) return unavailable();
        const authorization = request.headers.get("authorization") ?? "";
        if (
          authorization.length > 135 ||
          !timingSafeEqual(digest(authorization), expected)
        )
          return reply({ error: "unauthorized" }, 401);
        try {
          return reply(await repository.read());
        } catch {
          return unavailable();
        }
      }
      if (url.pathname !== "/scheduled")
        return reply({ error: "not-found" }, 404);
      if (request.method !== "POST")
        return reply({ error: "method-not-allowed" }, 405, { allow: "POST" });
      // Neon strips this reserved header at the trigger gateway.
      const invocation = request.headers.get("x-neon-trigger-invocation-id");
      if (
        !invocation ||
        invocation.length > 256 ||
        !triggerId ||
        triggerId.length > 256
      )
        return reply({ error: "unauthorized" }, 401);
      let attemptedAt: string;
      try {
        attemptedAt = await scheduledAt(
          request,
          invocation,
          triggerId,
          clock(),
        );
      } catch {
        return reply({ error: "invalid-schedule-delivery" }, 400);
      }
      try {
        if (await repository.claim(attemptedAt)) {
          const evidence = await collect();
          await repository.finish(attemptedAt, evidence);
        }
        return reply({ accepted: true });
      } catch {
        return unavailable();
      }
    },
  };
}
