import { inventoryReader } from "../retained-trial-ledger/inventory.ts";
import { inventoryApi } from "./api.ts";

/** Compose the separate Inventory endpoint without acquiring credentials or connecting on import. */
export default inventoryApi(
  process.env.BERTH_INVENTORY_TOKEN ?? "",
  inventoryReader(process.env),
);
