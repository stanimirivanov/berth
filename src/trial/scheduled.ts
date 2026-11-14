import { createHash } from "node:crypto";
/** Fixed four-hour deployment window; run owns connection creation after admission. */
export interface ScheduledOptions {
  startedAt: number;
  expiresAt: number;
  now?: () => number;
  run: (delivery: string, scheduledAt: number) => Promise<unknown>;
}
/** Neon must strip caller-supplied invocation headers at its authenticated trigger gateway. */
export function scheduledHandler(options: ScheduledOptions) {
  const clock = options.now ?? Date.now;
  return {
    /** Expiry is checked before parsing or invoking anything that can connect to a database. */
    async fetch(request: Request) {
      const now = clock();
      if (
        !Number.isFinite(now) ||
        !Number.isFinite(options.startedAt) ||
        options.expiresAt - options.startedAt !== 14400000 ||
        now < options.startedAt ||
        now >= options.expiresAt
      )
        return Response.json({ phase: "expired" });
      const url = new URL(request.url);
      if (
        request.method !== "POST" ||
        url.pathname !== "/scheduled" ||
        url.search
      )
        return new Response(null, { status: 404 });
      const id = request.headers.get("x-neon-trigger-invocation-id");
      if (!id || id.length > 256) return new Response(null, { status: 401 });
      let scheduledAt: number;
      const reader = request.body?.getReader();
      let text = "",
        size = 0;
      const decoder = new TextDecoder("utf-8", { fatal: true });
      try {
        if (reader)
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            size += chunk.value.length;
            if (size > 4096) throw Error();
            text += decoder.decode(chunk.value, { stream: true });
          }
        const body = JSON.parse(text + decoder.decode());
        scheduledAt = Date.parse(body?.data?.scheduled_at);
        if (
          body?.version !== 1 ||
          body?.invocation_id !== id ||
          body?.trigger?.type !== "schedule" ||
          typeof body?.trigger?.id !== "string" ||
          !body.trigger.id ||
          body.trigger.id.length > 256 ||
          !Number.isFinite(scheduledAt) ||
          scheduledAt > now ||
          scheduledAt < options.startedAt ||
          now - scheduledAt > 1200000
        )
          throw Error();
      } catch {
        return new Response(null, { status: 400 });
      } finally {
        await reader?.cancel().catch(() => undefined);
        reader?.releaseLock();
      }
      if (clock() >= options.expiresAt)
        return Response.json({ phase: "expired" });
      try {
        return Response.json({
          result: await options.run(
            createHash("sha256").update(id).digest("hex"),
            scheduledAt,
          ),
        });
      } catch {
        return Response.json(
          { error: "continuation-needs-reconciliation" },
          { status: 503 },
        );
      }
    },
  };
}
