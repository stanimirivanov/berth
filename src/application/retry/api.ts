import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { emptyControl } from "../../http/empty-control.ts";
import {
  decodeApproval,
  decodeContinuation,
  type RetryContinuation,
} from "./continuation.ts";
import { decodeRetryStatus, type RetryAction } from "./contract.ts";

const operationPath =
  /^\/api\/retry\/operations\/([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})(?:(\/continuation)|\/proposals\/([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})\/approve)?$/;
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
  continuation?: RetryContinuation,
) {
  const enabled = /^berth-retry-owner-v1\.[A-Za-z0-9_-]{43,86}$/.test(
    ownerCredential,
  );
  /** Domain-separated proof for a single bounded session. Key rotation invalidates old sessions. */
  const signature = (payload: string) =>
    createHmac("sha256", ownerCredential)
      .update(`berth-retry-session/v1:${payload}`)
      .digest("base64url");

  /** A Retry session permits reconciliation, retained status, and approval of a qualified proposal until expiry. */
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
      const match = operationPath.exec(url.pathname);
      const operation = match?.[1];
      const statusRead = match?.[2] !== undefined;
      const proposal = match?.[3] ?? null;
      const method = request.method;
      const operationRequest =
        operation &&
        (statusRead
          ? method === "GET"
          : proposal
            ? method === "POST"
            : method === "GET" || method === "POST");
      if (url.search || (!signIn && !operationRequest))
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
        if (statusRead || proposal) {
          if (!continuation) return reply({ error: "retry-unavailable" }, 503);
          const raw = await continuation(operation, proposal);
          const result = proposal
            ? decodeApproval(raw)
            : decodeContinuation(raw);
          if (!result)
            return proposal
              ? reply({ error: "proposal-no-longer-current" }, 409)
              : reply({ error: "not-found" }, 404);
          if (
            result.operation !== operation ||
            (proposal &&
              (!("continuation" in result) || result.continuation !== proposal))
          )
            throw Error("Retry approval or operation mismatch");
          return reply(result);
        }
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
