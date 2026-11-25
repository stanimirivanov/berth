import type { RequestSigner } from "oci-common";

/** Two fixed read-only checks; callers must reserve each individual invocation before calling. */
export function readinessTransport(
  region: string,
  namespace: string,
  compartment: string,
  signer: RequestSigner,
  fetcher: typeof fetch = fetch,
  retainedBucketName?: string,
) {
  if (
    !/^[a-z]{2}-[a-z]+-[1-9]$/.test(region) ||
    !/^[A-Za-z0-9_-]{1,64}$/.test(namespace) ||
    !/^ocid1[.]compartment[.]oc1[.][.][A-Za-z0-9]{1,128}$/.test(compartment)
  )
    throw Error("Invalid readiness target");
  const base = `https://objectstorage.${region}.oraclecloud.com`;
  return async (check: "namespace" | "empty") => {
    const uri =
      check === "namespace"
        ? `${base}/n/`
        : `${base}/n/${encodeURIComponent(namespace)}/b?${new URLSearchParams({ compartmentId: compartment, limit: "1" })}`;
    const signal = AbortSignal.timeout(5000),
      request = { uri, method: "GET" as const, headers: new Headers() };
    await signer.signHttpRequest(request);
    signal.throwIfAborted();
    const response = await fetcher(uri, {
      method: "GET",
      headers: request.headers,
      redirect: "error",
      signal,
    });
    const reader = response.body?.getReader();
    try {
      if (!response.ok || response.headers.get("opc-next-page") || !reader)
        return false;
      let text = "",
        bytes = 0;
      const decoder = new TextDecoder("utf-8", { fatal: true });
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.length;
        if (bytes > 4096) throw Error("Response limit");
        text += decoder.decode(chunk.value, { stream: true });
      }
      const value: unknown = JSON.parse(text + decoder.decode());
      if (check === "namespace") return value === namespace;
      if (!Array.isArray(value)) return false;
      if (!retainedBucketName) return value.length === 0;
      const candidate: unknown = value[0];
      return (
        value.length === 1 &&
        candidate !== null &&
        typeof candidate === "object" &&
        "name" in candidate &&
        candidate.name === retainedBucketName &&
        "namespace" in candidate &&
        candidate.namespace === namespace &&
        "compartmentId" in candidate &&
        candidate.compartmentId === compartment
      );
    } finally {
      await reader?.cancel().catch(() => undefined);
      reader?.releaseLock();
    }
  };
}
