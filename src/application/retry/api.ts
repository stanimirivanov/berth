import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { emptyControl } from "../../http/empty-control.ts";

import { decodeRetryStatus, type RetryStatus } from "./contract.ts";

/** Only the start action may use the read-only provider; status reads go to SQL. */
export type RetryAction = (
  action: "start" | "status",
  operation: string,
) => Promise<RetryStatus | null>;

const operationPath =
  /^\/api\/retry\/operations\/([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$/;
const lifetimeMs = 300000;

/** Compare bounded credential inputs without leaking an equality prefix. */
function equal(a: string, b: string) {
  return timingSafeEqual(
    createHash("sha256").update(a).digest(),
    createHash("sha256").update(b).digest(),
  );
}

/** Short-lived retry-only sessions use a credential format history and trial authentication reject. */
export function retryApi(
  ownerCredential: string,
  act: RetryAction,
  now: () => number = Date.now,
) {
  const enabled = /^berth-retry-owner-v1\.[A-Za-z0-9_-]{43,86}$/.test(
    ownerCredential,
  );
  /** Domain-separated proof for a single bounded session. Key rotation invalidates old sessions. */
  const signature = (payload: string) =>
    createHmac("sha256", ownerCredential)
      .update(`berth-retry-session/v1:${payload}`)
      .digest("base64url");

  /** A retry token authorizes only provider reconciliation and retained status, until its signed expiry. */
  function validSession(header: string) {
    const parts =
      /^Bearer brr1\.([0-9]{13})\.([a-f0-9-]{36})\.([A-Za-z0-9_-]{43})$/.exec(
        header,
      );
    if (!parts?.[3]) return false;
    const remaining = Number(parts[1]) - now();
    return (
      remaining > 0 &&
      remaining <= lifetimeMs &&
      equal(parts[3], signature(`${parts[1]}.${parts[2]}`))
    );
  }

  /** Never cache session material or reflect provider and database diagnostics. */
  const reply = (value: unknown, status = 200) =>
    Response.json(value, {
      status,
      headers: {
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });

  return {
    /** Match exact routes and authenticate before opening SQL or reading request bodies. */
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      const signIn =
        request.method === "POST" && url.pathname === "/api/retry/session";
      const operation = operationPath.exec(url.pathname)?.[1];
      if (
        url.search ||
        (!signIn && (!operation || !["GET", "POST"].includes(request.method)))
      )
        return reply({ error: "not-found" }, 404);
      if (!enabled) return reply({ error: "retry-unavailable" }, 503);
      const credential = request.headers.get("authorization") ?? "";
      if (
        credential.length > 256 ||
        !(signIn
          ? equal(credential, `Bearer ${ownerCredential}`)
          : validSession(credential))
      )
        return reply({ error: "unauthorized" }, 401);
      if (request.method === "POST" && !(await emptyControl(request)))
        return reply({ error: "body-not-allowed" }, 400);
      if (signIn) {
        const expires = now() + lifetimeMs;
        const payload = `${expires}.${randomUUID()}`;
        return reply({
          session: `brr1.${payload}.${signature(payload)}`,
          expiresAt: new Date(expires).toISOString(),
        });
      }
      if (request.method === "POST" && !validSession(credential))
        return reply({ error: "unauthorized" }, 401);
      if (!operation) return reply({ error: "not-found" }, 404);
      try {
        const status = decodeRetryStatus(
          await act(request.method === "POST" ? "start" : "status", operation),
        );
        if (status && status.operation !== operation)
          throw Error("Retry status mismatch");
        if (!status) return reply({ error: "not-found" }, 404);
        return reply(
          status,
          request.method === "POST" && status.stage === "checking-provider"
            ? 202
            : 200,
        );
      } catch {
        return reply({ error: "retry-unavailable" }, 503);
      }
    },
  };
}
