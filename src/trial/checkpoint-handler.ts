import { createHash, timingSafeEqual } from "node:crypto";

/** Expiring, fixed-route admission; schedule attestation requires Neon's stripping edge. */
interface Options {
  token: string;
  expiresAt: number;
  run: (idHash: string) => Promise<unknown>;
  evidence: () => Promise<unknown>;
}
/** Read a bounded envelope without buffering an attacker-controlled stream. */
async function body(request: Request, limit: number) {
  const reader = request.body?.getReader();
  let length = 0;
  let text = "";
  const decoder = new TextDecoder();
  try {
    if (reader)
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        length += chunk.value.length;
        if (length > limit) {
          await reader.cancel();
          throw Error();
        }
        text += decoder.decode(chunk.value, { stream: true });
      }
    return text + decoder.decode();
  } finally {
    reader?.releaseLock();
  }
}
/** Exposes evidence and attested scheduled work only; expiry precedes all database access. */
export function makeCheckpointHandler(options: Options) {
  return {
    /** Returns fixed failures; only the scheduled route can dispatch synthetic mutations. */
    async fetch(request: Request) {
      const url = new URL(request.url);
      if (
        request.method !== "POST" ||
        url.search ||
        !["/scheduled", "/evidence"].includes(url.pathname)
      )
        return new Response(null, { status: 404 });
      if (
        !Number.isFinite(options.expiresAt) ||
        Date.now() >= options.expiresAt
      )
        return url.pathname === "/scheduled"
          ? Response.json({ expired: true })
          : new Response(null, { status: 410 });
      let hash: string | undefined;
      if (url.pathname === "/scheduled") {
        const id = request.headers.get("x-neon-trigger-invocation-id");
        if (!id || id.length > 256) return new Response(null, { status: 401 });
        let envelope: {
          version?: unknown;
          invocation_id?: unknown;
          trigger?: { type?: unknown; id?: unknown };
          data?: { scheduled_at?: unknown };
        };
        try {
          envelope = JSON.parse(await body(request, 4096));
        } catch {
          return new Response(null, { status: 400 });
        }
        if (
          envelope?.version !== 1 ||
          envelope?.invocation_id !== id ||
          envelope?.trigger?.type !== "schedule" ||
          typeof envelope?.trigger?.id !== "string" ||
          typeof envelope?.data?.scheduled_at !== "string" ||
          !Number.isFinite(Date.parse(envelope.data.scheduled_at))
        )
          return new Response(null, { status: 401 });
        hash = createHash("sha256").update(id).digest("hex");
      } else {
        const expected = Buffer.from(`Bearer ${options.token}`);
        const supplied = Buffer.from(
          request.headers.get("authorization") ?? "",
        );
        if (
          options.token.length < 32 ||
          expected.length !== supplied.length ||
          !timingSafeEqual(expected, supplied)
        )
          return new Response(null, { status: 401 });
        try {
          await body(request, 0);
        } catch {
          return new Response(null, { status: 400 });
        }
      }
      try {
        return Response.json(
          hash ? await options.run(hash) : await options.evidence(),
        );
      } catch {
        return Response.json(
          { error: "checkpoint-failed-needs-inspection" },
          { status: 503 },
        );
      }
    },
  };
}
