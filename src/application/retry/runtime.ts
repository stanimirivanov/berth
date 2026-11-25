import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import {
  DefaultRequestSigner,
  SimpleAuthenticationDetailsProvider,
} from "oci-common";
import { retryObserver } from "../../providers/oci/retry-observation.ts";
import {
  type RetainedRetrySession,
  retainedRetrySession,
} from "../retained-trial-ledger/retry.ts";
import type { RetryContinuation } from "./continuation.ts";
import type { RetryAction } from "./contract.ts";
import type { RetryObserver } from "./observation.ts";
import { retryActions } from "./reconciliation.ts";

/** Server-only configuration for owner sign-in and separately scoped credentials. */
type Environment = Record<string, string | undefined>;

/** Build only the fixed OCI read observer. No ambient provider credentials or executor port are accepted. */
function observer(env: Environment): RetryObserver {
  const region = env.BERTH_RETRY_OCI_REGION ?? "";
  const namespace = env.BERTH_RETRY_OCI_NAMESPACE ?? "";
  const compartment = env.BERTH_RETRY_OCI_COMPARTMENT ?? "";
  const tenancy = env.BERTH_RETRY_OCI_TENANCY ?? "";
  const user = env.BERTH_RETRY_OCI_USER ?? "";
  const pem = env.BERTH_RETRY_OCI_KEY ?? "";
  if (
    !/^ocid1[.]tenancy[.]oc1[.][.][A-Za-z0-9]{1,128}$/.test(tenancy) ||
    !/^ocid1[.]user[.]oc1[.][.][A-Za-z0-9]{1,128}$/.test(user) ||
    !pem ||
    pem.length > 8192
  )
    throw Error("Retry observer unavailable");
  const key = createPrivateKey(pem);
  if (
    key.asymmetricKeyType !== "rsa" ||
    (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048
  )
    throw Error("Retry observer unavailable");
  // OCI identifies its public key using the DER fingerprint, independent of session signing.
  const fingerprint = createHash("md5")
    .update(createPublicKey(key).export({ type: "spki", format: "der" }))
    .digest("hex")
    .match(/../g)
    ?.join(":");
  if (!fingerprint || fingerprint !== env.BERTH_RETRY_OCI_FINGERPRINT)
    throw Error("Retry observer unavailable");
  return retryObserver(
    { region, namespace, compartment },
    new DefaultRequestSigner(
      new SimpleAuthenticationDetailsProvider(
        tenancy,
        user,
        fingerprint,
        pem,
        null,
      ),
    ),
  );
}

/** Status and missing read credentials never load a working provider transport. */
const unavailable: RetryObserver = {
  /** Deny before reserving a provider request. */
  supports: () => false,
  /** A missing read prerequisite never touches OCI. */
  observe: async () => ({ kind: "inconclusive" }),
};

/** Open SQL after Retry authentication and attach the read-only observer only for new checks. */
export function retryRuntime(
  env: Environment,
  withRetainedRetry: RetainedRetrySession = retainedRetrySession(env),
): RetryAction {
  return (action, operation) =>
    withRetainedRetry(async ({ ledger }) => {
      let provider = unavailable;
      if (action === "start") {
        try {
          provider = observer(env);
        } catch {
          // Preserve a durable read-scope stop even when OCI credentials are unavailable.
        }
      }
      return retryActions(ledger, provider)(action, operation);
    });
}

/** Approval and status only reach SQL. The fenced executor owns provider writes. */
export function retryContinuationRuntime(
  env: Environment,
  withRetainedRetry: RetainedRetrySession = retainedRetrySession(env),
): RetryContinuation {
  return (operation, proposal) =>
    withRetainedRetry(({ continuation }) => continuation(operation, proposal));
}
