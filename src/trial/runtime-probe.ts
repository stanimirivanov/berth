import { createHash, timingSafeEqual } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

/** Fixed failure categories safe to return without exposing provider error bodies. */
export type ProbeStage =
  | "runtime"
  | "credential-boundary"
  | "admin-credential"
  | "service-credential"
  | "database-url"
  | "database"
  | "alchemy"
  | "signing";
/** Carries only the reviewed stage; provider messages and credentials are discarded. */
export class ProbeFailure extends Error {
  constructor(readonly stage: ProbeStage) {
    super("probe-failed");
  }
}

/** Immutable admission settings and the protected operation supplied by the runtime. */
interface Options {
  /** Private bearer token; fewer than 32 characters fails admission. */
  token: string;
  /** Absolute Unix time in milliseconds; invalid or elapsed values fail closed. */
  expiresAt: number;
  /** Runs only after manual authentication and empty-input checks; never from schedules. */
  run: () => Promise<unknown>;
}
/**
 * Reads at most the byte limit, cancelling an oversized stream before parsing.
 * A zero limit admits empty adapter streams while rejecting all caller input.
 * @throws If the stream fails or exceeds the limit; callers return a fixed error.
 */
async function readBody(request: Request, limit: number) {
  const reader = request.body?.getReader();
  let text = "";
  let size = 0;
  const decoder = new TextDecoder();
  try {
    if (reader)
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > limit) {
          await reader.cancel();
          throw new Error("large");
        }
        text += decoder.decode(value, { stream: true });
      }
    text += decoder.decode();
    return text;
  } finally {
    reader?.releaseLock();
  }
}
/**
 * Creates the fixed-route, expiring HTTP probe and its instance-local receipt map.
 *
 * @remarks
 * Deploy only behind Neon’s edge, which strips client-supplied X-Neon headers.
 * Scheduler receipts are bounded observations, not durable idempotency records.
 * Expiry acknowledges schedules without work; it does not prevent billed requests.
 * @param options - Bearer admission, absolute expiry and the protected operation.
 * @returns A Fetch-compatible handler; errors expose only reviewed categories.
 */
export function makeProbe(options: Options) {
  const receipts = new Map<
    string,
    { deliveries: number; scheduledAt: string }
  >();
  return {
    /**
     * Admits only fixed POST routes: authenticated work/evidence/timeout or a
     * Neon-attested no-write schedule. Rejects arbitrary query and body input.
     * The first observed scheduled ID requests a retry; repeats acknowledge it.
     */
    async fetch(request: Request) {
      const url = new URL(request.url);
      if (
        !Number.isFinite(options.expiresAt) ||
        Date.now() >= options.expiresAt
      )
        return url.pathname === "/scheduled"
          ? Response.json({ expired: true })
          : new Response(null, { status: 410 });
      if (
        request.method !== "POST" ||
        url.search ||
        !["/", "/scheduled", "/evidence", "/timeout"].includes(url.pathname)
      )
        return new Response(null, { status: 404 });
      if (url.pathname === "/scheduled") {
        // This attestation is valid ONLY behind Neon's edge, which strips client X-Neon-* headers.
        const id = request.headers.get("x-neon-trigger-invocation-id");
        if (!id || id.length > 256) return new Response(null, { status: 401 });
        let body: {
          version?: unknown;
          invocation_id?: unknown;
          trigger?: { type?: unknown; id?: unknown };
          data?: { scheduled_at?: unknown };
        };
        try {
          body = JSON.parse(await readBody(request, 4096));
        } catch {
          return new Response(null, { status: 400 });
        }
        if (
          body?.version !== 1 ||
          body?.invocation_id !== id ||
          body?.trigger?.type !== "schedule" ||
          typeof body?.trigger?.id !== "string" ||
          typeof body?.data?.scheduled_at !== "string" ||
          !Number.isFinite(Date.parse(body.data.scheduled_at))
        )
          return new Response(null, { status: 401 });
        const hash = createHash("sha256").update(id).digest("hex");
        const previous = receipts.get(hash);
        const duplicate = previous !== undefined;
        if (receipts.size >= 8 && !duplicate)
          return Response.json({ bounded: true });
        receipts.set(hash, {
          deliveries: (previous?.deliveries ?? 0) + 1,
          scheduledAt: body.data.scheduled_at,
        });
        // Deliberately request one retry to observe stable delivery IDs; no protected work.
        return Response.json(
          { accepted: true, duplicate, idHash: hash },
          {
            status: duplicate ? 200 : 503,
            headers: duplicate ? {} : { "retry-after": "1" },
          },
        );
      }
      const supplied = Buffer.from(request.headers.get("authorization") ?? "");
      const expected = Buffer.from(`Bearer ${options.token}`);
      if (
        options.token.length < 32 ||
        supplied.length !== expected.length ||
        !timingSafeEqual(supplied, expected)
      )
        return new Response(null, { status: 401 });
      try {
        await readBody(request, 0);
      } catch {
        return Response.json(
          {
            error: "unexpected-input",
            bodyUsed: request.bodyUsed,
            webStream: typeof request.body?.getReader === "function",
          },
          { status: 400 },
        );
      }
      if (url.pathname === "/timeout") {
        const started = performance.now();
        try {
          await delay(1000, undefined, { signal: AbortSignal.timeout(25) });
        } catch {
          return Response.json(
            {
              timerAborted: true,
              elapsedMs: Math.round(performance.now() - started),
            },
            { status: 504 },
          );
        }
        return Response.json({ timerAborted: false }, { status: 500 });
      }
      if (url.pathname === "/evidence")
        return Response.json({
          receipts: [...receipts].map(([idHash, value]) => ({
            idHash,
            ...value,
          })),
        });
      try {
        return Response.json(await options.run());
      } catch (error) {
        return Response.json(
          {
            error: "probe-failed",
            ...(error instanceof ProbeFailure ? { stage: error.stage } : {}),
          },
          { status: 500 },
        );
      }
    },
  };
}
