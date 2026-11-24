import { createHash, timingSafeEqual } from "node:crypto";
import type { InventoryReader } from "./contract.ts";

const cursor = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const tokenShape = /^[A-Za-z0-9_-]{32,128}$/;

/** Authenticate the Inventory service credential, then translate one bounded list request. */
export function inventoryApi(token: string, reader: InventoryReader) {
  /** Send only the public projection or a fixed, uncached diagnostic. */
  const reply = (value: unknown, status = 200, headers = {}) =>
    Response.json(value, {
      status,
      headers: {
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        ...headers,
      },
    });
  const unavailable = () => reply({ error: "inventory-unavailable" }, 503);
  return {
    /** Reject unbounded and unauthorized requests before touching storage. */
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      if (url.pathname !== "/api/inventory")
        return reply({ error: "not-found" }, 404);
      if (request.method !== "GET")
        return reply({ error: "method-not-allowed" }, 405, { allow: "GET" });
      if (!tokenShape.test(token)) return unavailable();
      const authorization = request.headers.get("authorization") ?? "";
      if (
        authorization.length > 135 ||
        !timingSafeEqual(
          createHash("sha256").update(authorization).digest(),
          createHash("sha256").update(`Bearer ${token}`).digest(),
        )
      )
        return reply({ error: "unauthorized" }, 401);
      const after = url.searchParams.get("after"),
        rawLimit = url.searchParams.get("limit"),
        limit = rawLimit === null ? 20 : Number(rawLimit);
      if (
        url.search.length > 256 ||
        [...url.searchParams.keys()].some(
          (key) =>
            !["after", "limit"].includes(key) ||
            url.searchParams.getAll(key).length !== 1,
        ) ||
        (after !== null && !cursor.test(after)) ||
        (rawLimit !== null && !/^[1-9][0-9]?$/.test(rawLimit)) ||
        limit > 50
      )
        return reply({ error: "invalid-inventory-request" }, 400);
      try {
        const result = await reader.page(after, limit);
        return result.items.length <= limit ? reply(result) : unavailable();
      } catch {
        return unavailable();
      }
    },
  };
}
