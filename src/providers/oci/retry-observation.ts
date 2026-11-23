/** Fixed region, namespace and compartment authorized for the read-only OCI principal. */
export interface RetryScope {
  region: string;
  namespace: string;
  compartment: string;
}

/** The operation supplies only the saved bucket name within the fixed deployment scope. */
export interface RetryTarget extends RetryScope {
  bucket: string;
}

/** Closed provider observations. The database matches the scope and ownership tags. */
export type RetryObservation =
  | {
      kind: "present";
      id: string;
      etag: string;
      namespace: string;
      compartment: string;
      name: string;
      operation: string;
      marker: string;
      requestId: string;
      observedAt: string;
      configurationMatches: boolean;
    }
  | { kind: "not-found" | "absent" | "inconclusive" };

/** The only network capabilities exposed to retry reconciliation are signed GETs. */
export interface RetryObserver {
  supports(target: RetryTarget): boolean;
  observe(
    target: RetryTarget,
    probe: "bucket" | "list",
    deadline: number,
  ): Promise<RetryObservation>;
}

/** Sign only the request shape produced by this read-only transport. */
export interface RetrySigner {
  signHttpRequest(request: {
    uri: string;
    method: "GET";
    headers: Headers;
  }): Promise<unknown>;
}

/** A stalled signer, fetch or body read must settle on abort. */
async function beforeAbort<T>(
  signal: AbortSignal,
  work: () => Promise<T>,
): Promise<T> {
  signal.throwIfAborted();
  const stopped = Promise.withResolvers<never>();
  const stop = () => stopped.reject(Error("Retry provider check interrupted"));
  signal.addEventListener("abort", stop, { once: true });
  try {
    return await Promise.race([work(), stopped.promise]);
  } finally {
    signal.removeEventListener("abort", stop);
  }
}

/** Restrict provider values to plain JSON objects before extracting observations. */
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("Invalid provider observation");
  return value as Record<string, unknown>;
}

/** Bound JSON and cancel an unconsumed response without waiting for its cancellation hook. */
async function boundedJson(response: Response, signal: AbortSignal) {
  const reader = response.body?.getReader();
  if (!reader) throw Error("Provider body missing");
  try {
    let size = 0;
    let text = "";
    const decoder = new TextDecoder("utf-8", { fatal: true });
    for (let n = 0; n < 1024; n++) {
      const { done, value } = await beforeAbort(signal, () => reader.read());
      if (done) return JSON.parse(text + decoder.decode()) as unknown;
      size += value.byteLength;
      if (size > 16384) throw Error("Provider body too large");
      text += decoder.decode(value, { stream: true });
    }
    throw Error("Provider response incomplete");
  } finally {
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** Match exact bucket metadata, revision and the identity-bearing OCI request. */
function bucketObservation(
  value: unknown,
  response: Response,
): RetryObservation {
  const bucket = record(value);
  const tags = record(bucket.freeformTags);
  const { id, name, namespace, compartmentId: compartment } = bucket;
  const operation = tags["berth-operation"];
  const marker = tags["berth-marker"];
  const etag = response.headers.get("etag");
  const requestId = response.headers.get("opc-request-id");
  const date = response.headers.get("date") ?? "";
  const observedAt =
    /^[A-Z][a-z]{2}, [0-9]{2} [A-Z][a-z]{2} [0-9]{4} [0-9:]{8} GMT$/.test(date)
      ? Date.parse(date)
      : Number.NaN;
  if (
    typeof id !== "string" ||
    !/^ocid1[.]bucket[.][A-Za-z0-9._-]{1,200}$/.test(id) ||
    typeof name !== "string" ||
    typeof namespace !== "string" ||
    typeof compartment !== "string" ||
    typeof operation !== "string" ||
    typeof marker !== "string" ||
    !etag ||
    etag.length > 256 ||
    bucket.etag !== etag ||
    !requestId ||
    !/^[A-Za-z0-9._:/-]{1,200}$/.test(requestId) ||
    !Number.isFinite(observedAt)
  )
    return { kind: "inconclusive" };
  return {
    kind: "present",
    id,
    etag,
    name,
    namespace,
    compartment,
    operation,
    marker,
    requestId,
    observedAt: new Date(observedAt).toISOString(),
    configurationMatches:
      bucket.publicAccessType === "NoPublicAccess" &&
      bucket.storageTier === "Standard" &&
      bucket.versioning === "Disabled" &&
      bucket.autoTiering === "Disabled" &&
      bucket.objectEventsEnabled === false &&
      bucket.replicationEnabled === false &&
      bucket.isReadOnly === false &&
      !bucket.kmsKeyId &&
      bucket.isBucketKeyEnabled !== true &&
      !bucket.objectLifecyclePolicyEtag,
  };
}

/** Pin requests to one OCI scope. No SDK writes, redirects, pagination or retries are available. */
export function retryObserver(
  scope: RetryScope,
  signer: RetrySigner,
  send: typeof fetch = fetch,
): RetryObserver {
  if (
    !/^[a-z]{2}-[a-z]+-[1-9]$/.test(scope.region) ||
    !/^[A-Za-z0-9_-]{1,64}$/.test(scope.namespace) ||
    !/^ocid1[.]compartment[.]oc1[.][.][A-Za-z0-9]{1,128}$/.test(
      scope.compartment,
    )
  )
    throw Error("Invalid retry scope");
  const base = `https://objectstorage.${scope.region}.oraclecloud.com/n/${encodeURIComponent(scope.namespace)}/b`;

  /** Reject any target drift before signing or sending. */
  function supports(target: RetryTarget) {
    return (
      target.region === scope.region &&
      target.namespace === scope.namespace &&
      target.compartment === scope.compartment &&
      /^berth-[0-9a-f]{32}$/.test(target.bucket)
    );
  }

  return {
    supports,
    /** Sign one fixed GET and bound signing and response reads by the durable request deadline. */
    async observe(target, probe, deadline) {
      const remaining = deadline - Date.now();
      if (!supports(target) || !Number.isFinite(remaining) || remaining <= 0)
        throw Error("Retry check rejected");
      const uri =
        probe === "bucket"
          ? `${base}/${target.bucket}?fields=autoTiering`
          : `${base}?${new URLSearchParams({ compartmentId: scope.compartment, limit: "2" })}`;
      const signal = AbortSignal.timeout(Math.min(5000, Math.ceil(remaining)));
      const request = { uri, method: "GET" as const, headers: new Headers() };
      await beforeAbort(signal, () => signer.signHttpRequest(request));
      signal.throwIfAborted();
      const response = await beforeAbort(signal, () =>
        send(uri, {
          method: "GET",
          headers: request.headers,
          signal,
          redirect: "error",
        }),
      );
      if (response.status !== 200 || response.headers.has("opc-next-page")) {
        void response.body?.cancel().catch(() => undefined);
        return {
          kind:
            probe === "bucket" && response.status === 404
              ? "not-found"
              : "inconclusive",
        };
      }
      const body = await boundedJson(response, signal);
      signal.throwIfAborted();
      if (probe === "bucket") return bucketObservation(body, response);
      // A dedicated trial compartment with other resources needs owner review.
      return {
        kind:
          Array.isArray(body) && body.length === 0 ? "absent" : "inconclusive",
      };
    },
  };
}
