import { randomUUID, timingSafeEqual } from "node:crypto";
import { makeHttpStateStore } from "alchemy/State/HttpStateStore";
import type { ResourceState } from "alchemy/State/ResourceState";
import { isResourceState } from "alchemy/State/State";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";

/** Fixed synthetic phases; no caller-supplied resource identities or state values. */
export type StatePhase = "create" | "read" | "update" | "stale" | "delete";
/** Admission dependencies separated from cloud work for deterministic tests. */
interface ProbeOptions {
  token: string;
  expiresAt: number;
  run: (phase: StatePhase) => Promise<object>;
}
const phases: readonly string[] = [
  "create",
  "read",
  "update",
  "stale",
  "delete",
];
const bootId = randomUUID();
/**
 * Authenticated empty-body POST routes with a fixed expiry and redacted errors.
 * Responses expose only synthetic evidence. A partial body is refused immediately;
 * a stalled stream cannot keep admission alive indefinitely.
 */
export function makeStateProbe(options: ProbeOptions) {
  if (!options.token || !Number.isFinite(options.expiresAt))
    throw Error("Missing probe configuration");
  return async (request: Request): Promise<Response> => {
    const supplied = Buffer.from(request.headers.get("authorization") ?? "");
    const expected = Buffer.from(`Bearer ${options.token}`);
    if (
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    )
      return new Response(null, { status: 401 });
    if (Date.now() >= options.expiresAt)
      return new Response(null, { status: 410 });
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const url = new URL(request.url);
    const phase = url.pathname.slice(1);
    if (!phase || !phases.includes(phase) || url.search)
      return new Response(null, { status: 404 });
    if (request.body) {
      const reader = request.body.getReader();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const part = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(Error()), 2000);
          }),
        ]);
        if (!part.done) return new Response(null, { status: 400 });
      } catch {
        return new Response(null, { status: 400 });
      } finally {
        clearTimeout(timer);
        void reader.cancel().catch(() => {});
      }
    }
    try {
      return Response.json({
        bootId,
        ...(await options.run(phase as StatePhase)),
      });
    } catch {
      return Response.json({ error: "state-probe-failed" }, { status: 502 });
    }
  };
}
/** Credential-free state fixture; deliberately constant identifiers and payload. */
function value(marker: string): ResourceState {
  return {
    resourceType: "Berth.StateProbe",
    namespace: undefined,
    fqn: "probe",
    logicalId: "probe",
    instanceId: "synthetic-instance",
    providerVersion: 1,
    status: "created",
    downstream: [],
    bindings: [],
    props: { marker },
    attr: { marker },
  };
}
/**
 * Calls the actual pinned HTTP StateService with a dedicated store bearer token.
 * No management credentials, DDL, OCI calls, or retries. A two-second stale phase
 * models an older reader writing after a competing invocation; it is fault injection.
 */
export async function runStatePhase(phase: StatePhase) {
  const endpoint = new URL(process.env.BERTH_STATE_URL ?? "");
  if (
    endpoint.protocol !== "https:" ||
    !/^berth-state-trial\.[a-z0-9-]+\.workers\.dev$/.test(endpoint.hostname) ||
    endpoint.pathname !== "/" ||
    endpoint.search ||
    endpoint.username ||
    endpoint.password
  )
    throw Error("Invalid state endpoint");
  const token = process.env.BERTH_STATE_TOKEN;
  if (!token || !/^[a-f0-9]{64}$/.test(token))
    throw Error("Invalid state credential");
  for (const key of [
    "CLOUDFLARE_API_TOKEN",
    "NEON_API_KEY",
    "OCI_PRIVATE_KEY",
    "OCI_ADMIN_KEY",
  ]) {
    if (process.env[key]) throw Error("Management credential present");
  }
  for (const key of ["DATABASE_URL", "DATABASE_URL_UNPOOLED"]) {
    const url = new URL(process.env[key] ?? "");
    if (url.username !== "berth_runtime" || url.pathname !== "/neondb")
      throw Error("Owner credential present");
  }
  for (const key of [
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "NEON_AI_GATEWAY_TOKEN",
  ]) {
    if (process.env[key] && process.env[key] !== "disabled-for-berth-probe")
      throw Error("Unexpected injected credential");
  }
  let requests = 0;
  /** Pin credential-bearing calls to the trial origin, with eight dispatches and no redirects. */
  const boundedFetch: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== endpoint.origin || ++requests > 8)
      throw Error("State request boundary");
    return fetch(input, {
      ...init,
      redirect: "error",
      signal: AbortSignal.any([
        ...(init?.signal ? [init.signal] : []),
        AbortSignal.timeout(8000),
      ]),
    });
  };
  const request = { stack: "berth-state-trial", stage: "probe", fqn: "probe" };
  return Effect.runPromise(
    Effect.gen(function* () {
      const state = yield* makeHttpStateStore({
        url: endpoint.origin,
        authToken: token,
        id: "cloudflare-http",
      });
      let readMarker: string | undefined;
      if (phase === "stale") {
        const before = yield* state.get(request);
        if (!isResourceState(before)) throw Error("Missing prior state");
        readMarker = String(before.attr?.marker);
        yield* Effect.sleep("2 seconds");
      }
      if (phase === "create" || phase === "update" || phase === "stale")
        yield* state.set({
          ...request,
          value: value(
            phase === "create"
              ? "first"
              : phase === "update"
                ? "second"
                : "stale",
          ),
        });
      if (phase === "delete")
        yield* state.deleteStack({ stack: request.stack });
      const current = yield* state.get(request);
      const marker = isResourceState(current)
        ? current.attr?.marker
        : undefined;
      if (
        marker !== undefined &&
        !["first", "second", "stale"].includes(marker)
      )
        throw Error("Unexpected state");
      return {
        phase,
        marker: marker ?? null,
        readMarker: readMarker ?? null,
        requests,
        restrictedEnvironment: true,
      };
    }).pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(FetchHttpClient.Fetch, boundedFetch),
      Effect.timeout("15 seconds"),
    ),
  );
}
/** Hosted entrypoint configures admission lazily; invalid deployment fails closed. */
export default async function handler(request: Request): Promise<Response> {
  try {
    return await makeStateProbe({
      token: process.env.BERTH_TRIAL_TOKEN ?? "",
      expiresAt: Number(process.env.BERTH_STATE_EXPIRES_AT ?? NaN),
      run: runStatePhase,
    })(request);
  } catch {
    return new Response(null, { status: 503 });
  }
}
