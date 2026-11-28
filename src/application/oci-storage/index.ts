import {
  ociStorageEvidence,
  storageEvidenceSigner,
} from "../../providers/oci/storage-evidence.ts";
import { storageRepository } from "../../storage/postgres/oci-storage.ts";
import { ociStorageApi } from "./api.ts";
import type { StorageEvidence } from "./contract.ts";

const env = process.env;
const tenancy = env.BERTH_OCI_TENANCY ?? "";
const region = env.BERTH_OCI_REGION ?? "";

/** Resolve the scoped signing key only for a claimed schedule delivery. */
async function collect(): Promise<StorageEvidence> {
  const user = env.BERTH_OCI_USER ?? "";
  const pem = env.BERTH_OCI_KEY ?? "";
  let eligibility: unknown;
  try {
    const planEvidence = env.BERTH_OCI_FREE_PLAN_EVIDENCE ?? "";
    if (planEvidence.length > 1024) throw Error();
    eligibility = JSON.parse(planEvidence);
  } catch {
    return { gap: "account-unverified", reading: null };
  }
  try {
    const signer = storageEvidenceSigner(
      tenancy,
      user,
      pem,
      env.BERTH_OCI_FINGERPRINT,
    );
    return await ociStorageEvidence({ tenancy, region }, eligibility, signer)();
  } catch {
    return { gap: "oci-unavailable", reading: null };
  }
}

/** Dedicated read and scheduled collector entry point. Inventory's SQL and credentials stay separate. */
export default ociStorageApi(
  env.BERTH_OCI_STORAGE_TOKEN ?? "",
  storageRepository(tenancy, env),
  collect,
  env.BERTH_OCI_STORAGE_TRIGGER_ID ?? "",
);
