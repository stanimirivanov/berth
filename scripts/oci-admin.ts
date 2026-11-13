import { isAbsolute } from "node:path";
import { type HttpRequest, Region } from "oci-common";
import {
  createOciSigner,
  type OciConfig,
  OciSetupError,
  parseOciConfig,
  policyStatements,
} from "./oci-access.js";

import { captureUserRejection, OciUserRejection } from "./oci-diagnostics.js";
import type { Recovery, RecoveryPlan } from "./oci-recovery.js";

export interface AdminConfig {
  tenancyOcid: string;
  userOcid: string;
  domainOcid: string;
  region: string;
  fingerprint: string;
  privateKeyFile: string;
  passphraseFile?: string;
  name: string;
  trialEmail: string;
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
    "trialEmail",
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
  if (
    typeof v.trialEmail !== "string" ||
    v.trialEmail.length > 254 ||
    /\s/.test(v.trialEmail) ||
    !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(v.trialEmail)
  )
    throw new OciSetupError(
      "Supply trialEmail as a plain primary email address you control",
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
const notificationExtension =
  "urn:ietf:params:scim:schemas:oracle:idcs:extension:user:User";
const extension =
  "urn:ietf:params:scim:schemas:oracle:idcs:extension:capabilities:User";
export function userCreationBody(config: AdminConfig) {
  return {
    schemas: [
      "urn:ietf:params:scim:schemas:core:2.0:User",
      extension,
      notificationExtension,
    ],
    userName: `${config.name}-executor`,
    displayName: `${config.name}-executor`,
    // SCIM requires name.familyName even for service users; use a non-personal label.
    name: { familyName: `${config.name}-executor` },
    emails: [{ value: config.trialEmail, type: "work", primary: true }],
    [notificationExtension]: { bypassNotification: true },
    active: true,
    userType: "Service",
    [extension]: capabilities,
  };
}
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

/** Fresh creation or narrowly validated partial-run recovery. A durable journal must acknowledge intent before any write. */
type Transport = (url: string, init: RequestInit) => Promise<Response>;
export function bootstrapOci(
  config: AdminConfig,
  pem: string,
  passphrase: string | undefined,
  trialKey: TrialKey,
  journal: Journal,
  transport?: Transport,
): Promise<OciConfig>;
export function bootstrapOci(
  config: AdminConfig,
  pem: string,
  passphrase: string | undefined,
  trialKey: TrialKey,
  journal: Journal,
  transport: Transport,
  recovery: Recovery,
): Promise<OciConfig | RecoveryPlan>;
export async function bootstrapOci(
  config: AdminConfig,
  pem: string,
  passphrase: string | undefined,
  trialKey: TrialKey,
  journal: Journal,
  transport: Transport = fetch,
  recovery?: Recovery,
): Promise<OciConfig | RecoveryPlan> {
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
    let readFailure = "request failed before response";
    try {
      const response = await transport(url, {
        method,
        headers: signed.headers,
        ...(encoded === undefined ? {} : { body: encoded }),
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
      status = response.status;
      readFailure = "HTTP failure";
      if (operation === "CreateUser" && response.status === 400) {
        throw await captureUserRejection(response);
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error("HTTP failure");
      }
      // GetRecordedGroup returns one Group, with the unfiltered members attribute.
      // Its contract has no page parameter; member paging requires an explicit
      // attributes filter, which this caller never sends. An incidental list
      // header must not replace the identity and full-members checks below.
      // https://docs.oracle.com/en-us/iaas/tools/oci-cli/latest/oci_cli_docs/cmdref/identity-domains/group/get.html
      if (
        recovery &&
        method === "GET" &&
        operation !== "GetRecordedGroup" &&
        response.headers.get("opc-next-page")?.trim()
      ) {
        readFailure = "nonempty pagination token present";
        await response.body?.cancel();
        throw new Error("Ambiguous paginated response");
      }
      readFailure = "response body read failed";
      let data: unknown;
      try {
        data = await response.json();
      } catch (error) {
        if (error instanceof SyntaxError) readFailure = "invalid JSON response";
        throw error;
      }
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
    } catch (error) {
      if (error instanceof OciUserRejection) throw error;
      if (recovery && method === "GET")
        throw new OciSetupError(
          `${operation}${status === undefined ? "" : ` (HTTP ${status})`}: ${readFailure}. Read-only request; no recovery writes dispatched. No retry; preserve the journal and keys.`,
        );
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
  let compartmentOcid: string;
  let recoveredUser: Record<string, unknown> | undefined;
  let recoveredGroup: Record<string, unknown> | undefined;
  if (recovery) {
    if (recovery.userUrl !== `${scim}/Users`)
      throw new OciSetupError(
        "Journal domain URL differs from authenticated domain; no recovery writes",
      );
    compartmentOcid = ocid(recovery.compartmentOcid, "compartment");
    const existing = record(
      await request(
        "GetCompartment",
        `${identity}/compartments/${compartmentOcid}`,
      ),
    );
    if (
      existing.id !== compartmentOcid ||
      existing.compartmentId !== config.tenancyOcid ||
      existing.name !== config.name ||
      existing.description !== description ||
      existing.lifecycleState !== "ACTIVE"
    )
      throw new OciSetupError(
        "Recorded compartment identity, parent, name, description or state mismatch; no recovery writes",
      );
    const buckets = await request(
      "ListBuckets",
      `https://objectstorage.${config.region}.oraclecloud.com/n/${encodeURIComponent(namespace)}/b?${new URLSearchParams({ compartmentId: compartmentOcid, limit: "1" })}`,
    );
    if (!Array.isArray(buckets) || buckets.length !== 0)
      throw new OciSetupError(
        "Recorded compartment is not proven bucket-empty; no recovery writes",
      );
    if (recovery.identities) {
      const expected = recovery.identities;
      recoveredUser = record(
        await request(
          "GetRecordedUser",
          `${scim}/Users/${expected.userId}?${new URLSearchParams({ attributes: `id,ocid,userName,active,emails,${extension}` })}`,
        ),
      );
      if (
        recoveredUser.id !== expected.userId ||
        recoveredUser.ocid !== expected.userOcid ||
        recoveredUser.ocid === config.userOcid ||
        recoveredUser.userName !== `${config.name}-executor` ||
        recoveredUser.active !== true ||
        !Array.isArray(recoveredUser.emails) ||
        !recoveredUser.emails.some((value) => {
          const email = record(value);
          return email.primary === true && email.value === config.trialEmail;
        })
      )
        throw new OciSetupError(
          "Recorded user identity, active state or primary email mismatch; no recovery writes",
        );
      const actual = record(recoveredUser[extension]);
      if (
        Object.entries(capabilities).some(
          ([key, value]) => actual[key] !== value,
        )
      )
        throw new OciSetupError(
          "Recorded user capabilities mismatch; no recovery writes",
        );
      recoveredGroup = record(
        await request(
          "GetRecordedGroup",
          `${scim}/Groups/${expected.groupId}?${new URLSearchParams({ attributes: "id,ocid,displayName,members" })}`,
        ),
      );
      if (
        recoveredGroup.id !== expected.groupId ||
        recoveredGroup.ocid !== expected.groupOcid ||
        recoveredGroup.displayName !== `${config.name}-executor` ||
        !Array.isArray(recoveredGroup.members) ||
        recoveredGroup.members.length !== 1 ||
        record(recoveredGroup.members[0]).value !== expected.userId
      )
        throw new OciSetupError(
          "Recorded group identity or sole membership mismatch; no recovery writes",
        );
      const keys = record(
        await request(
          "SearchRecordedUserKeys",
          `${scim}/ApiKeys?${new URLSearchParams({ filter: `user.value eq "${expected.userId}"`, count: "2", startIndex: "1" })}`,
        ),
      );
      if (
        keys.totalResults !== 0 ||
        (keys.Resources !== undefined &&
          (!Array.isArray(keys.Resources) || keys.Resources.length !== 0))
      )
        throw new OciSetupError(
          "Recorded user already has keys or key absence is ambiguous; no recovery writes",
        );
    } else {
      for (const [collection, field] of [
        ["Users", "userName"],
        ["Groups", "displayName"],
      ]) {
        const found = record(
          await request(
            `Search${collection}`,
            `${scim}/${collection}?${new URLSearchParams({ filter: `${field} eq "${config.name}-executor"`, count: "2", startIndex: "1" })}`,
          ),
        );
        // SCIM allows Resources to be omitted when totalResults is exactly zero.
        if (
          found.totalResults !== 0 ||
          (found.Resources !== undefined &&
            (!Array.isArray(found.Resources) || found.Resources.length !== 0))
        )
          throw new OciSetupError(
            `${collection} already exists or absence is ambiguous; no recovery writes`,
          );
      }
    }
    const policies = await request(
      "ListPolicies",
      `${identity}/policies?${new URLSearchParams({ compartmentId: config.tenancyOcid, name: `${config.name}-objectstorage`, limit: "1" })}`,
    );
    if (!Array.isArray(policies) || policies.length !== 0)
      throw new OciSetupError(
        "Matching policy exists or absence is ambiguous; no recovery writes",
      );
    if (recovery.planOnly)
      return {
        recovery: "ready",
        requestsDispatched: recovery.identities ? 9 : 8,
        remainingWrites: recovery.identities ? 2 : 4,
      };
    await journal({
      phase: "recovery-start",
      originalJournalHash: recovery.journalHash,
      compartmentOcid,
      userCreateRejectedAttested: true,
      primaryEmailRejectionAttested: recovery.rejectedAttempts === 2,
    });
  } else {
    const compartment = record(
      await request("CreateCompartment", `${identity}/compartments`, {
        compartmentId: config.tenancyOcid,
        name: config.name,
        description,
      }),
    );
    compartmentOcid = ocid(compartment.id, "compartment");
  }
  const user =
    recoveredUser ??
    record(
      await request("CreateUser", `${scim}/Users`, userCreationBody(config)),
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
  const group =
    recoveredGroup ??
    record(
      await request(
        "CreateGroup",
        `${scim}/Groups?${new URLSearchParams({ attributes: "id,ocid,displayName,members" })}`,
        {
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"],
          displayName: `${config.name}-executor`,
          members: [{ value: userId, type: "User" }],
        },
      ),
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
