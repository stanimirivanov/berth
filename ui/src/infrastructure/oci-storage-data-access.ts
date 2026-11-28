import { decodeStorageSnapshot } from "../../contracts/oci-storage";
import type { createOwnerSession } from "../owner-access/owner-session";

/** Read the saved tenancy-wide storage result through shared Owner access. */
export function readOciStorage(
  owner: ReturnType<typeof createOwnerSession>,
  isCurrent: () => boolean,
) {
  return owner.read(
    "/api/inventory/oci-storage",
    decodeStorageSnapshot,
    isCurrent,
  );
}
