/** Retained evidence for one Berth-managed instance. */
export type InventoryInstance = {
  instance: string;
  operation: string;
  displayName: string;
  region: string;
  observedAt: string;
} & (
  | {
      presence: "verified-present";
      lastVerifiedAt: string;
      uncertainty: null;
    }
  | {
      presence: "uncertain";
      lastVerifiedAt: string | null;
      uncertainty: "create-unresolved" | "delete-unresolved";
    }
);

/** Browser-facing projection for the first catalog offering. */
export interface InventoryPage {
  offering: "oci-object-storage-bucket";
  coverage: "complete" | "incomplete";
  items: InventoryInstance[];
  next: string | null;
}
