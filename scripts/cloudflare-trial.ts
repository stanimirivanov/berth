/** Redacted event persisted before dispatch; bodies and authorization are excluded. */
export interface TrialEvent {
  phase: "intent" | "response";
  method: string;
  path: string;
  status?: number;
}
/** Fixed-account transport dependencies; callers persist the journal outside Git. */
interface TransportOptions {
  account: string;
  token: string;
  journal: (event: TrialEvent) => Promise<void>;
  fetch: typeof globalThis.fetch;
  limit?: number;
  cleanupReserve?: number;
  prior?: TrialEvent[];
}
/** Restrict management access to the one trial Worker and account store metadata. */
function allowed(method: string, path: string) {
  if (method === "GET")
    return /^\/(workers\/(scripts(?:\/berth-state-trial(?:\/settings)?)?|subdomain|durable_objects\/namespaces)|secrets_store\/stores(?:\/[a-f0-9]{32}(?:\/secrets(?:\/[a-f0-9]{32})?)?)?)$/.test(
      path,
    );
  if (method === "POST")
    return /^\/(secrets_store\/stores(?:\/[a-f0-9]{32}\/secrets)?|workers\/scripts\/berth-state-trial\/subdomain)$/.test(
      path,
    );
  if (method === "PUT") return path === "/workers/scripts/berth-state-trial";
  if (method === "DELETE")
    return /^\/(workers\/scripts\/berth-state-trial\?force=true|secrets_store\/stores\/[a-f0-9]{32}(?:\/secrets\/[a-f0-9]{32})?)$/.test(
      path,
    );
  return false;
}
/**
 * Account-pinned, no-retry transport with intent-before-dispatch and reserved cleanup.
 * Rehydrate prior journal events on every process start; uncertain writes stay spent.
 * Mutation deduplication is path/method based, so bootstrap creates both secrets in
 * one request. Callers must reconcile ownership before using DELETE.
 */
export function makeTrialTransport(options: TransportOptions) {
  if (!/^[a-f0-9]{32}$/.test(options.account)) throw Error("Invalid account");
  const limit = options.limit ?? 80;
  const reserve = options.cleanupReserve ?? 20;
  let used = (options.prior ?? []).filter((x) => x.phase === "intent").length;
  const mutations = new Set(
    (options.prior ?? [])
      .filter((x) => x.phase === "intent" && x.method !== "GET")
      .map((x) => `${x.method} ${x.path}`),
  );
  return {
    /** Dispatch once after durable intent; return bounded JSON and safe error categories. */
    async request(
      method: string,
      path: string,
      body?: object | FormData,
      cleanup = false,
    ): Promise<unknown> {
      if (!allowed(method, path))
        throw Error("Cloudflare request outside trial scope");
      const key = `${method} ${path}`;
      if (method !== "GET" && mutations.has(key))
        throw Error("Mutation already dispatched; reconcile journal");
      if (used >= (cleanup ? limit : limit - reserve))
        throw Error("Cloudflare request budget exhausted");
      // Reserve synchronously before yielding to the journal; failed reservations stay spent.
      used++;
      if (method !== "GET") mutations.add(key);
      await options.journal({ phase: "intent", method, path });
      let response: Response;
      try {
        response = await options.fetch(
          `https://api.cloudflare.com/client/v4/accounts/${options.account}${path}`,
          {
            method,
            redirect: "error",
            signal: AbortSignal.timeout(15000),
            headers: {
              Authorization: `Bearer ${options.token}`,
              ...(body && !(body instanceof FormData)
                ? { "content-type": "application/json" }
                : {}),
            },
            ...(body
              ? { body: body instanceof FormData ? body : JSON.stringify(body) }
              : {}),
          },
        );
      } catch {
        throw Error("Cloudflare request outcome uncertain");
      }
      await options.journal({
        phase: "response",
        method,
        path,
        status: response.status,
      });
      let envelope: {
        success?: boolean;
        result?: unknown;
        result_info?: { total_pages?: number; cursor?: string };
      };
      try {
        const chunks: Uint8Array[] = [];
        let length = 0;
        if (!response.body) throw Error();
        for await (const chunk of response.body) {
          length += chunk.length;
          if (length > 1048576) throw Error();
          chunks.push(chunk);
        }
        envelope = JSON.parse(Buffer.concat(chunks).toString());
      } catch {
        throw Error("Cloudflare response invalid; reconcile journal");
      }
      if (!response.ok || envelope.success !== true)
        throw Error(`Cloudflare HTTP ${response.status}; reconcile journal`);
      if (
        (envelope.result_info?.total_pages ?? 1) > 1 ||
        envelope.result_info?.cursor
      )
        throw Error("Cloudflare pagination exceeds trial scope");
      return envelope.result;
    },
    /** Includes failed and uncertain dispatches, not just successful responses. */
    count: () => used,
  };
}
/**
 * Metadata matching pinned Alchemy Deploy.ts, with SQLite and no credential values.
 * Bootstrap uploads the unmodified official Worker; no routes or paid services.
 */
export function workerMetadata(name: string, account: string, storeId: string) {
  if (name !== "berth-state-trial") throw Error("Invalid trial name");
  if (!/^[a-f0-9]{32}$/.test(account) || !/^[a-f0-9]{32}$/.test(storeId))
    throw Error("Invalid identifier");
  return {
    main_module: "Api.js",
    compatibility_date: "2026-10-26",
    compatibility_flags: ["new_module_registry"],
    bindings: [
      ...Object.entries({
        ALCHEMY_PHASE: "runtime",
        ALCHEMY_WORKER_NAME: name,
        ALCHEMY_STACK_NAME: "CloudflareStateStore",
        ALCHEMY_STAGE: name,
        ALCHEMY_CLOUDFLARE_ACCOUNT_ID: account,
        ALCHEMY_STATE_STORE_VERSION: "8",
      }).map(([name, text]) => ({ type: "plain_text", name, text })),
      ...["AlchemyStateStoreToken", "StateStoreEncryptionKey"].map((name) => ({
        type: "secrets_store_secret",
        name,
        store_id: storeId,
        secret_name: `${name}_berth_state_trial`,
      })),
      { type: "durable_object_namespace", name: "Store", class_name: "Store" },
    ],
    exports: { Store: { type: "durable-object", storage: "sqlite" } },
    observability: { enabled: false },
  };
}
