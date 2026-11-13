import { isAbsolute } from "node:path";
import { type HttpRequest, Region } from "oci-common";
import {
  createOciSigner,
  type OciConfig,
  OciSetupError,
  parseOciConfig,
  policyStatements,
} from "./oci-access.js";

export interface AdminConfig {
  tenancyOcid: string;
  userOcid: string;
  domainOcid: string;
  region: string;
  fingerprint: string;
  privateKeyFile: string;
  passphraseFile?: string;
  name: string;
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new OciSetupError("Unexpected OCI response/configuration shape");
  return value as Record<string, unknown>;
}
function ocid(value: unknown, kind: string): string {
  if (
    typeof value !== "string" ||
    !new RegExp(`^ocid1\\.${kind}\\.oc1\\.[a-z0-9-]*\\.[a-z0-9]{8,255}$`).test(
      value,
    )
  )
    throw new OciSetupError(
      "Missing or invalid OCI identifier; reconcile the private journal",
    );
  return value;
}
function regionFor(id: string) {
  const region = Object.values(Region).find(
    (entry) =>
      entry instanceof Region &&
      entry.regionId === id &&
      entry.realm.realmId === "oc1",
  );
  if (!(region instanceof Region))
    throw new OciSetupError("Select a known commercial OCI home region");
  return region;
}
export function parseAdminConfig(value: unknown): AdminConfig {
  const v = record(value);
  const required = [
    "tenancyOcid",
    "userOcid",
    "domainOcid",
    "region",
    "fingerprint",
    "privateKeyFile",
    "name",
  ];
  if (
    required.some((k) => typeof v[k] !== "string") ||
    Object.keys(v).some((k) => !required.includes(k) && k !== "passphraseFile")
  )
    throw new OciSetupError(
      "Missing or unknown administrator configuration field",
    );
  for (const kind of ["tenancy", "user", "domain"])
    ocid(v[`${kind}Ocid`], kind);
  regionFor(String(v.region));
  if (
    !/^[a-z][a-z0-9-]{2,39}$/.test(String(v.name)) ||
    !/^[a-f0-9]{2}(:[a-f0-9]{2}){15}$/.test(String(v.fingerprint)) ||
    !isAbsolute(String(v.privateKeyFile)) ||
    (v.passphraseFile !== undefined &&
      (typeof v.passphraseFile !== "string" || !isAbsolute(v.passphraseFile)))
  )
    throw new OciSetupError(
      "Invalid name, fingerprint or private credential path",
    );
  return v as unknown as AdminConfig;
}
export const capabilities = {
  canUseApiKeys: true,
  canUseAuthTokens: false,
  canUseConsole: false,
  canUseConsolePassword: false,
  canUseCustomerSecretKeys: false,
  canUseDbCredentials: false,
  canUseOAuth2ClientCredentials: false,
  canUseSmtpCredentials: false,
};
const extension =
  "urn:ietf:params:scim:schemas:oracle:idcs:extension:capabilities:User";
type Journal = (event: Record<string, unknown>) => Promise<void>;
type TrialKey = {
  publicKey: string;
  fingerprint: string;
  privateKeyFile: string;
};
function scimId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9-]{1,128}$/.test(value))
    throw new OciSetupError(
      "Missing SCIM identifier; reconcile the private journal",
    );
  return value;
}

/** Fresh creation only. A durable journal must acknowledge intent before any write. */
export async function bootstrapOci(
  config: AdminConfig,
  pem: string,
  passphrase: string | undefined,
  trialKey: TrialKey,
  journal: Journal,
  transport: (url: string, init: RequestInit) => Promise<Response> = fetch,
): Promise<OciConfig> {
  parseAdminConfig(config);
  const signer = createOciSigner(config, pem, passphrase);
  const identity = `https://identity.${config.region}.oci.oraclecloud.com/20160918`;
  async function request(
    operation: string,
    url: string,
    body?: Record<string, unknown>,
  ) {
    const method = body === undefined ? "GET" : "POST";
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    const signed: HttpRequest = {
      method,
      uri: url,
      headers: new Headers(),
      ...(encoded === undefined ? {} : { body: encoded }),
    };
    if (encoded !== undefined)
      signed.headers.set("content-type", "application/json");
    await signer.signHttpRequest(signed);
    if (body !== undefined)
      await journal({ phase: "intent", operation, url, body });
    let status: number | undefined;
    try {
      const response = await transport(url, {
        method,
        headers: signed.headers,
        ...(encoded === undefined ? {} : { body: encoded }),
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
      status = response.status;
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error("HTTP failure");
      }
      const data: unknown = await response.json();
      // Persist only identifiers needed for reconciliation, never raw response bodies.
      if (body !== undefined) {
        const r = record(data);
        await journal({
          phase: "confirmed",
          operation,
          id: r.id,
          ocid: r.ocid,
          fingerprint: r.fingerprint,
        });
      }
      return data;
    } catch {
      throw new OciSetupError(
        `${operation}${status === undefined ? "" : ` (HTTP ${status})`} failed or its outcome is uncertain. No retry. Reconcile journal before further setup.`,
      );
    }
  }
  const tenancy = record(
    await request("GetTenancy", `${identity}/tenancies/${config.tenancyOcid}`),
  );
  if (
    tenancy.id !== config.tenancyOcid ||
    String(tenancy.homeRegionKey).toLowerCase() !==
      regionFor(config.region).regionCode?.toLowerCase()
  )
    throw new OciSetupError(
      "Tenancy or home region mismatch; no mutations dispatched",
    );
  const domain = record(
    await request("GetDomain", `${identity}/domains/${config.domainOcid}`),
  );
  if (
    domain.id !== config.domainOcid ||
    domain.compartmentId !== config.tenancyOcid ||
    domain.lifecycleState !== "ACTIVE" ||
    typeof domain.url !== "string"
  )
    throw new OciSetupError("Expected an active existing root identity domain");
  const endpoint = new URL(domain.url);
  if (
    endpoint.protocol !== "https:" ||
    !/^idcs-[a-z0-9]+\.identity\.oraclecloud\.com$/.test(endpoint.hostname) ||
    endpoint.port ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.pathname !== "/"
  )
    throw new OciSetupError(
      "Unexpected identity domain endpoint; no mutations dispatched",
    );
  const scim = `${endpoint.origin}/admin/v1`;
  const namespace = await request(
    "GetNamespace",
    `https://objectstorage.${config.region}.oraclecloud.com/n/`,
  );
  if (
    typeof namespace !== "string" ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(namespace)
  )
    throw new OciSetupError("Unexpected Object Storage namespace");
  const description =
    "Berth disposable Object Storage trial; owner-managed IAM cleanup";
  const compartment = record(
    await request("CreateCompartment", `${identity}/compartments`, {
      compartmentId: config.tenancyOcid,
      name: config.name,
      description,
    }),
  );
  const compartmentOcid = ocid(compartment.id, "compartment");
  const user = record(
    await request("CreateUser", `${scim}/Users`, {
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:User", extension],
      userName: `${config.name}-executor`,
      displayName: `${config.name}-executor`,
      // SCIM requires name.familyName even for service users; use a non-personal label.
      name: { familyName: `${config.name}-executor` },
      active: true,
      userType: "Service",
      [extension]: capabilities,
    }),
  );
  const userOcid = ocid(user.ocid, "user");
  if (userOcid === config.userOcid)
    throw new OciSetupError(
      "Provider returned administrator identity; stopped",
    );
  const userId = scimId(user.id);
  const actualCapabilities = record(user[extension]);
  if (
    Object.entries(capabilities).some(
      ([key, value]) => actualCapabilities[key] !== value,
    )
  )
    throw new OciSetupError(
      "API-only capabilities not confirmed; reconcile created user before proceeding",
    );
  const group = record(
    await request("CreateGroup", `${scim}/Groups`, {
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"],
      displayName: `${config.name}-executor`,
      members: [{ value: userId, type: "User" }],
    }),
  );
  const groupOcid = ocid(group.ocid, "group");
  scimId(group.id);
  if (
    !Array.isArray(group.members) ||
    group.members.length !== 1 ||
    record(group.members[0]).value !== userId
  )
    throw new OciSetupError("Dedicated group membership not confirmed");
  const key = record(
    await request("CreateApiKey", `${scim}/ApiKeys`, {
      schemas: ["urn:ietf:params:scim:schemas:oracle:idcs:apikey"],
      user: { value: userId },
      key: trialKey.publicKey,
    }),
  );
  scimId(key.id);
  if (key.fingerprint !== trialKey.fingerprint)
    throw new OciSetupError("Registered trial key fingerprint mismatch");
  const runtime = parseOciConfig({
    tenancyOcid: config.tenancyOcid,
    userOcid,
    groupOcid,
    compartmentOcid,
    region: config.region,
    homeRegion: config.region,
    namespace,
    fingerprint: trialKey.fingerprint,
    privateKeyFile: trialKey.privateKeyFile,
  });
  const policy = record(
    await request("CreatePolicy", `${identity}/policies`, {
      compartmentId: config.tenancyOcid,
      name: `${config.name}-objectstorage`,
      description,
      statements: policyStatements(runtime),
    }),
  );
  ocid(policy.id, "policy");
  return runtime;
}
