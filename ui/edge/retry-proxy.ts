import { emptyControl } from "../../src/http/empty-control.js";
import { origin, readJson } from "./read-proxy.js";

/** Fixed upstream and canonical site. Retry bearer credentials are never added from Pages configuration. */
export interface RetryContext {
  request: Request;
  env: {
    BERTH_HISTORY_SITE_ORIGIN?: string;
    BERTH_RETRY_NEON_ORIGIN?: string;
    BERTH_HISTORY_NEON_ORIGIN?: string;
    BERTH_INVENTORY_NEON_ORIGIN?: string;
  };
}

const route =
  /^\/api\/retry\/operations\/([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})(?:(\/continuation)|\/proposals\/([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})\/approve)?$/;
const owner = /^Bearer berth-retry-owner-v1\.[A-Za-z0-9_-]{43,86}$/;
const session = /^Bearer brr1\.[0-9]{13}\.[a-f0-9-]{36}\.[A-Za-z0-9_-]{43}$/;
const errors: Partial<Record<number, string>> = {
  400: "retry-request-rejected",
  401: "unauthorized",
  403: "forbidden",
  404: "not-found",
  409: "proposal-no-longer-current",
};

/** Allow only same-origin, bodyless Retry routes and issue at most one upstream request. */
export async function retryProxy(
  { request, env }: RetryContext,
  upstream: typeof fetch,
) {
  const reply = (value: unknown, status: number) =>
    Response.json(value, {
      status,
      headers: {
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  const unavailable = () => reply({ error: "retry-unavailable" }, 503);
  try {
    const url = new URL(request.url);
    const site = origin(env.BERTH_HISTORY_SITE_ORIGIN);
    const browserOrigin = request.headers.get("origin");
    const fetchSite = request.headers.get("sec-fetch-site");
    if (
      url.origin !== site.origin ||
      (browserOrigin !== null && browserOrigin !== site.origin) ||
      (fetchSite !== null &&
        fetchSite !== "same-origin" &&
        fetchSite !== "none")
    ) {
      return reply({ error: "forbidden" }, 403);
    }
    const method = request.method;
    const signIn = url.pathname === "/api/retry/session" && method === "POST";
    const match = route.exec(url.pathname);
    const allowed =
      match &&
      (match[2]
        ? method === "GET"
        : match[3]
          ? method === "POST"
          : method === "GET" || method === "POST");
    if (url.search || (!signIn && !allowed))
      return reply({ error: "not-found" }, 404);
    const authorization = request.headers.get("authorization") ?? "";
    if (!(signIn ? owner : session).test(authorization))
      return reply({ error: "unauthorized" }, 401);
    if (!(await emptyControl(request))) {
      return reply({ error: "body-not-allowed" }, 400);
    }
    const target = origin(env.BERTH_RETRY_NEON_ORIGIN);
    if (
      !/^[a-z0-9-]+\.compute\.[a-z0-9.-]+\.neon\.tech$/.test(target.hostname) ||
      [env.BERTH_HISTORY_NEON_ORIGIN, env.BERTH_INVENTORY_NEON_ORIGIN].some(
        (value) => value?.replace(/\/$/, "") === target.origin,
      )
    ) {
      return unavailable();
    }
    target.pathname = url.pathname;
    const response = await upstream(target, {
      method,
      headers: { accept: "application/json", authorization },
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(30000),
    });
    if (response.status === 200 || response.status === 202) {
      try {
        return reply(await readJson(response), response.status);
      } finally {
        if (!response.bodyUsed) void response.body?.cancel().catch(() => {});
      }
    }
    void response.body?.cancel().catch(() => {});
    const error = errors[response.status];
    return error ? reply({ error }, response.status) : unavailable();
  } catch {
    return unavailable();
  }
}
