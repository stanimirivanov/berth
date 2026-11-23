import {
  decodeInventoryPage,
  type InventoryPage,
} from "../inventory/contract.ts";
import { type RetainedTrialDatabase, retainedTrialResult } from "./sql.ts";

/** Read one offering page through a connection granted only Inventory reader capability. */
export function retainedInventoryLedger(db: RetainedTrialDatabase) {
  return {
    /** Use the existing bounded SQL projection. The cursor remains opaque to the caller. */
    async page(
      after: string | null = null,
      limit = 20,
    ): Promise<InventoryPage> {
      return decodeInventoryPage(
        await retainedTrialResult(
          db,
          "SELECT berth_inventory.inventory_page($1,$2) AS result",
          [after, limit],
        ),
      );
    },
  };
}
