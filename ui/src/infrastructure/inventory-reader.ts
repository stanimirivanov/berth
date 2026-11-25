import { InjectionToken } from "@angular/core";
import type { OwnerRead } from "../owner-access/owner-session";
import type { InventoryPage } from "./inventory-model";

/** Read the first page or follow an opaque cursor through Owner access. */
export interface InventoryReader {
  page(
    after: string | null,
    isCurrent: () => boolean,
  ): Promise<OwnerRead<InventoryPage>>;
}

/** The shell wires the same-origin Inventory reader into this feature. */
export const INVENTORY_READER = new InjectionToken<InventoryReader>(
  "Inventory reader",
);
