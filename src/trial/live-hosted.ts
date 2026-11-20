import { createHash, timingSafeEqual } from "node:crypto";
import { liveEnvironment } from "./live-environment.js";
import { scheduledHandler } from "./scheduled.js";

/** Closed control vocabulary; requests never choose operations or provider targets. */
export type LiveAction = "evidence" | "usage" | "cleanup" | "scheduled";
/** Runtime port invoked only after authentication and the deployment window check. */
export type LiveRun = (
  environment: ReturnType<typeof liveEnvironment>,
  action: LiveAction,
  delivery?: string,
) => Promise<unknown>;

/**
 * Inspect authenticated controls for zero bytes, never trusting Content-Length.
 * Stop at the first payload byte, after eight reads, on abort, or after one second.
 * Rejected input is cancelled best-effort without awaiting an untrusted cancel hook;
 * read/lock failures deny admission and never expose their underlying error.
 */
async function emptyControl(request: Request): Promise<boolean> {
  if (request.signal.aborted) return false;
  if (!request.body) return true;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stop: (() => void) | undefined;
  let empty = false;
  try {
    reader = request.body.getReader();
    const input = reader;
    const stopped = new Promise<false>((resolve) => {
      stop = () => resolve(false);
      timer = setTimeout(stop, 1000);
      request.signal.addEventListener("abort", stop, { once: true });
      if (request.signal.aborted) stop();
    });
    /** Stop on payload or the read-count cap; only EOF proves an empty stream. */
    const inspect = async () => {
      for (let reads = 0; reads < 8; reads++) {
        const chunk = await input.read();
        if (chunk.done) return true;
        if (!(chunk.value instanceof Uint8Array) || chunk.value.byteLength > 0)
          return false;
      }
      return false;
    };
    empty = await Promise.race([inspect(), stopped]);
    return empty && !request.signal.aborted;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    if (stop) request.signal.removeEventListener("abort", stop);
    if (reader) {
      if (!empty) void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
}

/** Fixed private controls plus gateway-attested schedules; no environment parsing before admission. */
export function makeLiveHandler(
  env: Record<string, string | undefined>,
  run: LiveRun,
  now: () => number = Date.now,
  admission?: (
    e: ReturnType<typeof liveEnvironment>,
    request: Request,
  ) => Promise<Response>,
) {
  return {
    /** Expired/unauthenticated calls perform no SQL, signing or provider work; errors are redacted. */
    async fetch(request: Request): Promise<Response> {
      const startedAt = Number(env.BERTH_EXECUTOR_STARTED_AT),
        expiresAt = Number(env.BERTH_EXECUTOR_EXPIRES_AT);
      if (
        !Number.isFinite(startedAt) ||
        expiresAt - startedAt !== 14400000 ||
        !Number.isFinite(now()) ||
        now() < startedAt ||
        now() >= expiresAt
      )
        return Response.json({ phase: "expired" });
      const url = new URL(request.url);
      if (url.pathname === "/scheduled")
        return scheduledHandler({
          startedAt,
          expiresAt,
          now,
          run: (delivery) => run(liveEnvironment(env), "scheduled", delivery),
        }).fetch(request);
      if (
        request.method !== "POST" ||
        url.search ||
        !(
          ["/evidence", "/usage", "/cleanup"].includes(url.pathname) ||
          (admission && ["/preview", "/submit"].includes(url.pathname))
        )
      )
        return new Response(null, { status: 404 });
      const authorization = request.headers.get("authorization") ?? "",
        token = env.BERTH_TRIAL_TOKEN ?? "";
      if (
        !/^[A-Za-z0-9_-]{32,128}$/.test(token) ||
        authorization.length > 256 ||
        !timingSafeEqual(
          createHash("sha256").update(authorization).digest(),
          createHash("sha256").update(`Bearer ${token}`).digest(),
        )
      )
        return new Response(null, { status: 401 });
      const headers = { "cache-control": "no-store" };
      // These controls take no payload; a caller cannot override the fixed operation.
      if (
        !["/preview", "/submit"].includes(url.pathname) &&
        !(await emptyControl(request))
      )
        return Response.json(
          { error: "body-not-allowed" },
          { status: 400, headers },
        );
      try {
        if (now() >= expiresAt)
          return Response.json({ phase: "expired" }, { headers });
        if (admission && ["/preview", "/submit"].includes(url.pathname))
          return await admission(liveEnvironment(env), request);
        return Response.json(
          await run(liveEnvironment(env), url.pathname.slice(1) as LiveAction),
          { headers },
        );
      } catch {
        return Response.json(
          { error: "live-executor-unavailable" },
          { status: 503, headers },
        );
      }
    },
  };
}
