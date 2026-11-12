import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { isAbsolute } from "node:path";
import {
  DefaultRequestSigner,
  type HttpRequest,
  Region,
  SimpleAuthenticationDetailsProvider,
} from "oci-common";

export class OciSetupError extends Error {}

export interface OciConfig {
  tenancyOcid: string;
  userOcid: string;
  groupOcid: string;
  compartmentOcid: string;
  region: string;
  homeRegion: string;
  namespace: string;
  fingerprint: string;
  privateKeyFile: string;
  passphraseFile?: string;
}

export function parseOciConfig(value: unknown): OciConfig {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new OciSetupError("Expected an OCI configuration object");
  const config = value as Record<string, unknown>;
  const fields = [
    "tenancyOcid",
    "userOcid",
    "groupOcid",
    "compartmentOcid",
    "region",
    "homeRegion",
    "namespace",
    "fingerprint",
    "privateKeyFile",
  ];
  if (
    fields.some((key) => typeof config[key] !== "string") ||
    Object.keys(config).some(
      (key) => !fields.includes(key) && key !== "passphraseFile",
    )
  ) {
    throw new OciSetupError("Missing or unknown OCI configuration fields");
  }
  for (const kind of ["tenancy", "user", "group", "compartment"]) {
    if (
      !new RegExp(
        `^ocid1\\.${kind}\\.oc1\\.[a-z0-9-]*\\.[a-z0-9]{8,255}$`,
      ).test(String(config[`${kind}Ocid`]))
    ) {
      throw new OciSetupError("Invalid commercial-realm OCID or resource type");
    }
  }
  // Use SDK constants only, avoiding region discovery from ambient files/IMDS.
  const region = Object.values(Region).find(
    (entry) =>
      entry instanceof Region &&
      entry.regionId === config.region &&
      entry.realm.realmId === "oc1",
  );
  if (!region || config.region !== config.homeRegion)
    throw new OciSetupError("Select a known commercial OCI home region");
  if (
    !/^[a-zA-Z0-9_-]{1,128}$/.test(String(config.namespace)) ||
    !/^[a-f0-9]{2}(:[a-f0-9]{2}){15}$/.test(String(config.fingerprint)) ||
    !isAbsolute(String(config.privateKeyFile)) ||
    (config.passphraseFile !== undefined &&
      (typeof config.passphraseFile !== "string" ||
        !isAbsolute(config.passphraseFile)))
  ) {
    throw new OciSetupError(
      "Invalid namespace, fingerprint or absolute credential-file path",
    );
  }
  return config as unknown as OciConfig;
}

export function policyStatements(config: OciConfig): string[] {
  parseOciConfig(config);
  const scope = `Allow group id ${config.groupOcid} to`;
  const target = `in compartment id ${config.compartmentOcid}`;
  return [
    `${scope} manage buckets ${target} where any {request.permission='BUCKET_INSPECT', request.permission='BUCKET_READ', request.permission='BUCKET_CREATE', request.permission='BUCKET_DELETE'}`,
    `${scope} manage objects ${target} where any {request.permission='OBJECT_INSPECT', request.permission='OBJECT_READ', request.permission='OBJECT_CREATE', request.permission='OBJECT_DELETE'}`,
    `${scope} read metrics ${target} where target.metrics.namespace='oci_objectstorage'`,
  ];
}

type Transport = (url: string, init: RequestInit) => Promise<Response>;

export async function verifyOciAccess(
  config: OciConfig,
  pem: string,
  passphrase?: string,
  transport: Transport = fetch,
) {
  parseOciConfig(config);
  const key = createPrivateKey(
    passphrase === undefined ? pem : { key: pem, passphrase },
  );
  if (
    key.asymmetricKeyType !== "rsa" ||
    (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048
  ) {
    throw new OciSetupError(
      "An RSA signing key of at least 2048 bits is required",
    );
  }
  // MD5 here is OCI's key identifier, not a cryptographic signature or password hash.
  const fingerprint = createHash("md5")
    .update(createPublicKey(key).export({ type: "spki", format: "der" }))
    .digest("hex")
    .match(/../g)
    ?.join(":");
  if (fingerprint !== config.fingerprint)
    throw new OciSetupError("Signing key fingerprint mismatch");
  const provider = new SimpleAuthenticationDetailsProvider(
    config.tenancyOcid,
    config.userOcid,
    config.fingerprint,
    key.export({ type: "pkcs8", format: "pem" }).toString(),
    null,
  );
  const signer = new DefaultRequestSigner(provider);
  let requestsDispatched = 0;
  async function request(
    operation: string,
    method: "GET" | "POST",
    url: string,
    body?: string,
  ) {
    const signed: HttpRequest = {
      method,
      uri: url,
      headers: new Headers(),
      ...(body === undefined ? {} : { body }),
    };
    if (body !== undefined)
      signed.headers.set("content-type", "application/json");
    await signer.signHttpRequest(signed);
    requestsDispatched++;
    let response: Response;
    try {
      response = await transport(url, {
        method,
        headers: signed.headers,
        ...(body === undefined ? {} : { body }),
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new OciSetupError(
        `${operation} transport failed; dispatched ${requestsDispatched} request(s), no retry`,
      );
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new OciSetupError(
        `${operation} failed (HTTP ${response.status}); dispatched ${requestsDispatched} request(s), no retry`,
      );
    }
    // Never print provider response bodies, signing headers, OCIDs or key paths.
    return { response, data: (await response.json()) as unknown };
  }
  const storage = `https://objectstorage.${config.region}.oraclecloud.com`;
  const namespace = await request("GetNamespace", "GET", `${storage}/n/`);
  if (namespace.data !== config.namespace)
    throw new OciSetupError("Namespace mismatch; stopped after 1 request");
  const query = new URLSearchParams({
    compartmentId: config.compartmentOcid,
    limit: "1",
  });
  const buckets = await request(
    "ListBuckets",
    "GET",
    `${storage}/n/${encodeURIComponent(config.namespace)}/b?${query}`,
  );
  if (
    !Array.isArray(buckets.data) ||
    buckets.data.length !== 0 ||
    buckets.response.headers.has("opc-next-page")
  ) {
    throw new OciSetupError(
      "Trial compartment is not proven empty; stopped after 2 requests",
    );
  }
  const end = new Date();
  const metrics = await request(
    "SummarizeMetricsData",
    "POST",
    `https://telemetry.${config.region}.oraclecloud.com/20180401/metrics/actions/summarizeMetricsData?${new URLSearchParams({ compartmentId: config.compartmentOcid })}`,
    JSON.stringify({
      namespace: "oci_objectstorage",
      query: "StoredBytes[1h].sum()",
      resolution: "1h",
      startTime: new Date(end.getTime() - 2 * 60 * 60 * 1000).toISOString(),
      endTime: end.toISOString(),
    }),
  );
  if (!Array.isArray(metrics.data))
    throw new OciSetupError(
      "Unexpected Monitoring response; stopped after 3 requests",
    );
  return {
    checkedAt: new Date().toISOString(),
    readOnlyAccess: "passed",
    requestsDispatched,
    checks: {
      namespace: "verified",
      compartmentEmpty: "verified",
      monitoringQuery: "accepted",
    },
    usageEvidence:
      metrics.data.length === 0
        ? "inconclusive-no-metrics"
        : "metrics-present-not-billing-evidence",
    remaining: [
      "Owner inspection of all effective IAM grants and group memberships",
      "Owner confirmation of account type, home region and dated aggregate allowance headroom",
      "Live bucket/object permissions remain untested until the gated trial",
      "Server-side credential deployment and administrative cleanup",
    ],
  };
}
