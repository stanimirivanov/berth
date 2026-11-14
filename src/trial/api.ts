import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import type { makeLedger } from "./ledger.js";
import {
  preflight,
  proposal,
  type TrialConfiguration,
  trialWindow,
  validateConfiguration,
} from "./preflight.js";

/** Private admission ports; no SDK, execution dispatch or credentials appear in responses. */
export interface TrialApiOptions {
  /** Optional owner-prepared identity for the metered live preview contract. */
  operation?: string;
  /** Bind prepared live previews to the reviewed credential identity and window. */
  binding?: string;
  token: string;
  previewKey: string;
  configuration: TrialConfiguration;
  /** Inject clock for deterministic expiry tests; production uses Date.now. */
  now?: () => number;
  /** Current owner aggregate evidence loaded server-side; never accepted in HTTP bodies. */
  headroom: () => Promise<unknown>;
  /** Bounded read-only credential/target validation; false or rejection must never permit creation. */
  verifyCredentials: () => Promise<boolean>;
  ledger: Pick<ReturnType<typeof makeLedger>, "start">;
  /** Read-only durable projection; never fetches provider data or gates on creation headroom. */
  readUsage?: (operation: string) => Promise<Record<string, unknown>>;
  /** Must durably/idempotently admit only existing owned operations, without headroom gating. */
  admitCleanup: (
    operation: string,
  ) => Promise<{ operation: string; status: "cleanup-requested" }>;
}
const uuid =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
/** Read a bounded JSON object; cancel oversized input without buffering the rest. */
async function envelope(request: Request) {
  if (request.headers.get("content-type") !== "application/json") throw Error();
  const reader = request.body?.getReader();
  let size = 0,
    text = "";
  const decoder = new TextDecoder("utf-8", { fatal: true });
  try {
    if (reader)
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.length;
        if (size > 2048) {
          await reader.cancel();
          throw Error();
        }
        text += decoder.decode(chunk.value, { stream: true });
      }
    const value: unknown = JSON.parse(text + decoder.decode());
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw Error();
    return value as Record<string, unknown>;
  } finally {
    reader?.releaseLock();
  }
}
/** Constant-length digest comparison also bounds token processing before authentication. */
function equal(a: string, b: string) {
  return timingSafeEqual(
    createHash("sha256").update(a).digest(),
    createHash("sha256").update(b).digest(),
  );
}
/**
 * Fixed private POST API: signed read-only preview, atomic ledger submission and
 * owned cleanup admission plus read-only usage history. No cloud executor is
 * invoked here. Deploy over TLS only.
 */
export function makeTrialApi(options: TrialApiOptions) {
  const c = Object.freeze({ ...options.configuration });
  validateConfiguration(c);
  if (
    (options.operation !== undefined && !uuid.test(options.operation)) ||
    !/^[A-Za-z0-9_-]{32,128}$/.test(options.token) ||
    !/^[A-Za-z0-9_-]{32,128}$/.test(options.previewKey)
  )
    throw Error("Invalid admission credentials");
  const token = options.token,
    key = options.previewKey,
    clock = options.now ?? Date.now;
  const configurationHash = createHash("sha256")
    .update(
      JSON.stringify([proposal(c, "configuration"), options.binding ?? ""]),
    )
    .digest("hex");
  const sign = (payload: string) =>
    createHmac("sha256", key).update(payload).digest("base64url");
  /** Explicit output allowlists and no-store headers prevent credentials/provider details escaping. */
  const reply = (body: unknown, status = 200) =>
    Response.json(body, {
      status,
      headers: {
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  /** Preview is a signed immutable proposal, persisted atomically only on accepted submission. */
  function decode(value: unknown, now: number) {
    if (typeof value !== "string" || value.length > 1024) throw Error();
    const [payload, signature, ...extra] = value.split(".");
    if (
      !payload ||
      !signature ||
      extra.length ||
      !equal(sign(payload), signature)
    )
      throw Error();
    const p = JSON.parse(Buffer.from(payload, "base64url").toString()) as {
      operation: string;
      issued: number;
      configurationHash: string;
    };
    if (
      !uuid.test(p.operation) ||
      (options.operation !== undefined && p.operation !== options.operation) ||
      p.configurationHash !== configurationHash ||
      !Number.isFinite(p.issued) ||
      p.issued > now ||
      now - p.issued >= 300000
    )
      throw Error();
    return p.operation;
  }
  return {
    /** Authentication precedes body parsing or any port call; all failures have fixed diagnostics. */
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      if (
        request.method !== "POST" ||
        url.search ||
        !["/preview", "/submit", "/cleanup", "/usage"].includes(url.pathname)
      )
        return reply({ error: "not-found" }, 404);
      const authorization = request.headers.get("authorization") ?? "";
      if (
        authorization.length > 256 ||
        !equal(authorization, `Bearer ${token}`)
      )
        return reply({ error: "unauthorized" }, 401);
      let body: Record<string, unknown>, operation: string | undefined;
      const now = clock();
      try {
        if (!Number.isFinite(now)) throw Error();
        body = await envelope(request);
        const keys = Object.keys(body).sort().join(",");
        if (url.pathname === "/preview") {
          if (keys !== "") throw Error();
        } else if (url.pathname === "/submit") {
          if (keys !== "preview") throw Error();
          operation = decode(body.preview, now);
        } else {
          if (
            keys !== "operation" ||
            typeof body.operation !== "string" ||
            !uuid.test(body.operation)
          )
            throw Error();
          operation = body.operation;
        }
      } catch {
        return reply({ error: "invalid-request-or-preview" }, 400);
      }
      try {
        if (url.pathname === "/usage") {
          if (!operation || !options.readUsage) throw Error();
          const report = await options.readUsage(operation);
          if (report.operation !== operation) throw Error();
          const {
            coverage,
            providerHardCap,
            threshold,
            uploadedAt,
            closedAt,
            evidence,
            history,
            warnings,
          } = report;
          return reply({
            operation,
            coverage,
            providerHardCap,
            threshold,
            uploadedAt,
            closedAt,
            evidence,
            history,
            warnings,
          });
        }
        if (url.pathname === "/cleanup") {
          if (!operation) throw Error();
          const result = await options.admitCleanup(operation);
          if (
            result.operation !== operation ||
            result.status !== "cleanup-requested"
          )
            throw Error();
          return reply({ operation, status: "cleanup-requested" }, 202);
        }
        const evidence = await options.headroom();
        const reasons = preflight(c, evidence, clock());
        if (reasons.length)
          return reply(
            {
              error: "creation-blocked",
              reasons,
              coverage: "partial-owner-attested",
              hardSpendingCap: false,
            },
            409,
          );
        if (!(await options.verifyCredentials()))
          return reply({ error: "credentials-unverified" }, 403);
        const acceptedAt = clock();
        if (preflight(c, evidence, acceptedAt).length)
          return reply(
            {
              error: "creation-blocked",
              coverage: "partial-owner-attested",
              hardSpendingCap: false,
            },
            409,
          );
        if (url.pathname === "/submit") {
          try {
            operation = decode(body.preview, acceptedAt);
          } catch {
            return reply({ error: "invalid-request-or-preview" }, 400);
          }
        }
        if (url.pathname === "/preview") {
          const id = options.operation ?? randomUUID(),
            payload = Buffer.from(
              JSON.stringify({
                operation: id,
                issued: acceptedAt,
                configurationHash,
              }),
            ).toString("base64url");
          return reply({
            preview: `${payload}.${sign(payload)}`,
            previewExpiresAt: new Date(acceptedAt + 300000).toISOString(),
            proposal: proposal(c, id),
            coverage: "partial-owner-attested",
            hardSpendingCap: false,
          });
        }
        if (!operation) throw Error();
        const exact = proposal(c, operation);
        const record = await options.ledger.start({
          operation,
          ...c,
          digest: exact.object.sha256,
        });
        if (
          record.operation !== operation ||
          record.compartment !== c.compartment ||
          record.namespace !== c.namespace ||
          record.region !== c.region ||
          record.digest !== exact.object.sha256 ||
          record.bucket !== exact.bucket.name ||
          record.object_name !== "trial.bin" ||
          !["active", "needs-reconciliation", "succeeded", "failed"].includes(
            record.outcome,
          )
        )
          throw Error();
        return reply(
          {
            operation,
            status: record.outcome,
            ...trialWindow(record.started_at, record.expires_at),
          },
          202,
        );
      } catch {
        return reply(
          {
            error:
              url.pathname === "/usage"
                ? "usage-unavailable"
                : "admission-uncertain-reconcile-operation",
            operation,
          },
          503,
        );
      }
    },
  };
}
