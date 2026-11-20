/** Pages runtime bindings. Both tokens are secrets, supplied independently. */
interface HistoryBindings {
  BERTH_HISTORY_SITE_ORIGIN?: string;
  BERTH_HISTORY_NEON_ORIGIN?: string;
  BERTH_HISTORY_ACCESS_TOKEN?: string;
  BERTH_HISTORY_UPSTREAM_TOKEN?: string;
}

/** Minimal Cloudflare Pages context consumed by the history routes. */
export interface HistoryContext {
  request: Request;
  env: HistoryBindings;
}

const root = "/api/history";
const uuid =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const token = /^[A-Za-z0-9_-]{32,128}$/;
const maxBytes = 128 * 1024;

/** Accept only a canonical HTTPS origin, optionally with a trailing slash. */
function origin(value: string | undefined): URL {
  if (!value || !/^https:\/\/[a-z0-9.-]+\/?$/.test(value)) throw Error();
  const url = new URL(value);
  if (value !== url.origin && value !== url.href) throw Error();
  return url;
}

/** Hash both inputs and compare every digest byte without an early exit. */
async function matches(actual: string, expected: string) {
  const hash = async (value: string) =>
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    );
  const [left, right] = await Promise.all([hash(actual), hash(expected)]);
  let difference = 0;
  for (const [index, byte] of left.entries())
    difference |= byte ^ (right[index] ?? 0);
  return difference === 0;
}

/** Allow a UUID cursor and limit from 1 to 50 on list requests. */
function validQuery(url: URL, detail: boolean): boolean {
  if (url.search.length > 256 || (detail && url.search)) return false;
  const seen = new Set<string>();
  for (const [key, value] of url.searchParams) {
    if (seen.has(key)) return false;
    if (key === "before") {
      if (!uuid.test(value)) return false;
    } else if (key === "limit") {
      if (!/^[1-9][0-9]?$/.test(value) || Number(value) > 50) return false;
    } else return false;
    seen.add(key);
  }
  return true;
}

/** Read bounded JSON without forwarding upstream headers or a partial response. */
async function readJson(response: Response): Promise<unknown> {
  if (
    !/^application\/json(?:\s*;|$)/i.test(
      response.headers.get("content-type") ?? "",
    ) ||
    !response.body
  )
    throw Error();
  const reader = response.body.getReader();
  const bytes = new Uint8Array(maxBytes);
  let length = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done)
        return JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(
            bytes.subarray(0, length),
          ),
        );
      if (part.value.byteLength > maxBytes - length) throw Error();
      bytes.set(part.value, length);
      length += part.value.byteLength;
    }
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

/** Authorize a single same-origin read, then send one bounded request to the configured Neon Function. */
export async function historyProxy(
  { request, env }: HistoryContext,
  upstream: typeof fetch = fetch,
): Promise<Response> {
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
  const unavailable = () => reply({ error: "history-unavailable" }, 503);
  try {
    const site = origin(env.BERTH_HISTORY_SITE_ORIGIN);
    const neon = origin(env.BERTH_HISTORY_NEON_ORIGIN);
    if (!/^[a-z0-9-]+\.compute\.[a-z0-9.-]+\.neon\.tech$/.test(neon.hostname))
      return unavailable();
    const access = env.BERTH_HISTORY_ACCESS_TOKEN,
      service = env.BERTH_HISTORY_UPSTREAM_TOKEN;
    if (
      !access ||
      !service ||
      !token.test(access) ||
      !token.test(service) ||
      access === service
    )
      return unavailable();
    const url = new URL(request.url);
    const browserOrigin = request.headers.get("origin");
    const fetchSite = request.headers.get("sec-fetch-site");
    if (
      url.origin !== site.origin ||
      (browserOrigin !== null && browserOrigin !== site.origin) ||
      (fetchSite !== null &&
        fetchSite !== "same-origin" &&
        fetchSite !== "none")
    )
      return reply({ error: "forbidden" }, 403);
    if (request.method !== "GET")
      return reply({ error: "method-not-allowed" }, 405, { allow: "GET" });
    const detail = url.pathname !== root;
    if (
      detail &&
      (!url.pathname.startsWith(`${root}/`) ||
        !uuid.test(url.pathname.slice(root.length + 1)))
    )
      return reply({ error: "not-found" }, 404);
    const authorization = request.headers.get("authorization") ?? "";
    if (
      authorization.length > 135 ||
      !(await matches(authorization, `Bearer ${access}`))
    )
      return reply({ error: "unauthorized" }, 401);
    if (!validQuery(url, detail))
      return reply({ error: "invalid-history-request" }, 400);
    const target = new URL(neon);
    target.pathname = url.pathname;
    target.search = url.search;
    const response = await upstream(target, {
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${service}`,
      },
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(4000),
    });
    if (response.status === 200) {
      try {
        return reply(await readJson(response));
      } finally {
        if (!response.bodyUsed) void response.body?.cancel().catch(() => {});
      }
    }
    void response.body?.cancel().catch(() => {});
    return detail && response.status === 404
      ? reply({ error: "not-found" }, 404)
      : unavailable();
  } catch {
    return unavailable();
  }
}
