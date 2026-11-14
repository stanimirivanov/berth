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
/** Fixed private controls plus gateway-attested schedules; no environment parsing before admission. */
export function makeLiveHandler(
  env: Record<string, string | undefined>,
  run: LiveRun,
  now: () => number = Date.now,
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
        !["/evidence", "/usage", "/cleanup"].includes(url.pathname)
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
      if (request.body)
        return Response.json(
          { error: "body-not-allowed" },
          { status: 400, headers },
        );
      try {
        if (now() >= expiresAt)
          return Response.json({ phase: "expired" }, { headers });
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
