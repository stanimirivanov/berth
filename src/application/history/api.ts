import { createHash, timingSafeEqual } from "node:crypto";
import {
  type HistoryRead,
  historyPageLimit,
  isHistoryOperationId,
} from "./contract.ts";

/** Independent private read API; execution expiry never authorizes or blocks historical reads. */
export function historyApi(token: string, read: HistoryRead) {
  return {
    /** Authenticate before protected work; strict routes and closed errors reveal no database details. */
    async fetch(request: Request): Promise<Response> {
      /** Fixed response headers and diagnostics; never mirror SQL errors or credentials. */
      const reply = (value: unknown, status = 200) =>
        Response.json(value, {
          status,
          headers: {
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
          },
        });
      const url = new URL(request.url);
      if (
        request.method !== "GET" ||
        !/^\/api\/history(?:\/[^/]+)?$/.test(url.pathname)
      )
        return reply({ error: "not-found" }, 404);
      if (!/^[A-Za-z0-9_-]{32,128}$/.test(token))
        return reply({ error: "history-unavailable" }, 503);
      const authorization = request.headers.get("authorization") ?? "";
      if (
        authorization.length > 256 ||
        !timingSafeEqual(
          createHash("sha256").update(authorization).digest(),
          createHash("sha256").update(`Bearer ${token}`).digest(),
        )
      )
        return reply({ error: "unauthorized" }, 401);
      const operation = url.pathname.slice("/api/history/".length) || null;
      const detail = url.pathname !== "/api/history";
      const before = url.searchParams.get("before"),
        rawLimit = url.searchParams.get("limit"),
        limit = rawLimit === null ? 20 : Number(rawLimit);
      if (
        (detail &&
          (!operation || !isHistoryOperationId(operation) || url.search)) ||
        [...url.searchParams.keys()].some(
          (key) =>
            !["before", "limit"].includes(key) ||
            url.searchParams.getAll(key).length !== 1,
        ) ||
        (before !== null && !isHistoryOperationId(before)) ||
        (rawLimit !== null && !/^[1-9][0-9]?$/.test(rawLimit)) ||
        limit > historyPageLimit
      )
        return reply({ error: "invalid-history-request" }, 400);
      try {
        if (operation === null) return reply(await read.list(before, limit));
        const value = await read.detail(operation);
        if (value && value.operation !== operation)
          return reply({ error: "history-unavailable" }, 503);
        return reply(value, value === null ? 404 : 200);
      } catch {
        return reply({ error: "history-unavailable" }, 503);
      }
    },
  };
}
