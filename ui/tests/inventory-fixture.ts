import type {
  InventoryInstance,
  InventoryPage,
} from "../src/infrastructure/inventory-model";
import { first } from "./history-fixture";

/** A retained verified bucket for Inventory tests. */
export const verified = {
  instance: "10000000-0000-4000-8000-000000000001",
  operation: first,
  displayName: "Alpha bucket",
  region: "eu-frankfurt-1",
  presence: "verified-present",
  observedAt: "2026-11-20T09:00:00Z",
  lastVerifiedAt: "2026-11-20T09:00:00Z",
  uncertainty: null,
} satisfies InventoryInstance;
/** A separately identified bucket with unresolved deletion. */
export const uncertain = {
  ...verified,
  instance: "10000000-0000-4000-8000-000000000002",
  displayName: "Zeta bucket",
  presence: "uncertain",
  observedAt: "2026-11-20T09:05:00Z",
  uncertainty: "delete-unresolved",
} satisfies InventoryInstance;

/** A fixture for the public Inventory wire shape, including empty scopes. */
export function inventoryPage(
  items: InventoryInstance[],
  next: string | null = null,
  coverage: InventoryPage["coverage"] = "complete",
): InventoryPage {
  return { offering: "oci-object-storage-bucket", coverage, items, next };
}
