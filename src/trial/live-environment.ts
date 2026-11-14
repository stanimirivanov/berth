import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { restrictedConnection } from "./executor-security.js";

/** Fixed live deployment, with no ambient OCI config, local file lookup or owner API token. */
export function liveEnvironment(env: Record<string, string | undefined>) {
  const allowed = [
    "OCI_TENANCY_OCID",
    "OCI_USER_OCID",
    "OCI_FINGERPRINT",
    "OCI_PRIVATE_KEY",
    "OCI_REGION",
    "OCI_COMPARTMENT_OCID",
    "OCI_NAMESPACE",
  ];
  for (const name of Object.keys(env))
    if (
      env[name] &&
      ((name.startsWith("OCI_") && !allowed.includes(name)) ||
        name.startsWith("NEON_API_KEY"))
    )
      throw Error("Unexpected credentials");
  const connection = restrictedConnection(env);
  const startedAt = Number(env.BERTH_EXECUTOR_STARTED_AT),
    expiresAt = Number(env.BERTH_EXECUTOR_EXPIRES_AT);
  const operation = env.BERTH_EXECUTOR_OPERATION ?? "",
    token = env.BERTH_TRIAL_TOKEN ?? "";
  const tenancy = env.OCI_TENANCY_OCID ?? "",
    user = env.OCI_USER_OCID ?? "",
    compartment = env.OCI_COMPARTMENT_OCID ?? "";
  const region = env.OCI_REGION ?? "",
    namespace = env.OCI_NAMESPACE ?? "";
  if (
    env.BERTH_EXECUTOR_MODE !== "live" ||
    !Number.isFinite(startedAt) ||
    expiresAt - startedAt !== 14400000 ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
      operation,
    ) ||
    !/^[A-Za-z0-9_-]{32,128}$/.test(token) ||
    !/^ocid1\.tenancy\.oc1\.\.[A-Za-z0-9]{1,128}$/.test(tenancy) ||
    !/^ocid1\.user\.oc1\.\.[A-Za-z0-9]{1,128}$/.test(user) ||
    !/^ocid1\.compartment\.oc1\.\.[A-Za-z0-9]{1,128}$/.test(compartment) ||
    !/^[a-z]{2}-[a-z]+-[1-9]$/.test(region) ||
    !/^[A-Za-z0-9_-]{1,64}$/.test(namespace)
  )
    throw Error("Invalid live deployment");
  const privateKey = env.OCI_PRIVATE_KEY ?? "";
  if (privateKey.length > 8192) throw Error("Invalid trial key");
  const key = createPrivateKey(privateKey);
  if (
    key.asymmetricKeyType !== "rsa" ||
    (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048
  )
    throw Error("Invalid trial key");
  // OCI identifies API keys by the MD5 fingerprint of their public SPKI DER; this is not a password hash.
  const fingerprint = createHash("md5")
    .update(createPublicKey(key).export({ type: "spki", format: "der" }))
    .digest("hex")
    .match(/../g)
    ?.join(":");
  if (!fingerprint || fingerprint !== env.OCI_FINGERPRINT)
    throw Error("Trial key mismatch");
  return {
    connection,
    startedAt,
    expiresAt,
    operation,
    token,
    tenancy,
    user,
    compartment,
    region,
    namespace,
    privateKey,
    fingerprint,
  };
}
