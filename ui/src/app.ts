import {
  ChangeDetectionStrategy,
  Component,
  ViewEncapsulation,
} from "@angular/core";
import { RouterLink, RouterLinkActive, RouterOutlet } from "@angular/router";
import { createInventoryReader } from "./infrastructure/inventory-data-access";
import { INVENTORY_READER } from "./infrastructure/inventory-reader";
import { InventoryStore } from "./infrastructure/inventory-store";
import { UsageStore } from "./infrastructure/usage-store";
import { createHistoryReader } from "./operation-history/history-data-access";
import { HISTORY_READER } from "./operation-history/history-reader";
import { HistoryStore } from "./operation-history/history-store";
import {
  createOwnerSession,
  OWNER_SESSION,
} from "./owner-access/owner-session";

/** Shared navigation and tab-memory owner access for the routed views. */
@Component({
  selector: "berth-app",
  imports: [RouterLink, RouterLinkActive, RouterOutlet],
  providers: [
    { provide: OWNER_SESSION, useFactory: createOwnerSession },
    {
      provide: HISTORY_READER,
      useFactory: createHistoryReader,
      deps: [OWNER_SESSION],
    },
    HistoryStore,
    {
      provide: INVENTORY_READER,
      useFactory: createInventoryReader,
      deps: [OWNER_SESSION],
    },
    InventoryStore,
    UsageStore,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./app.html",
  styleUrl: "./app.css",
  encapsulation: ViewEncapsulation.None,
})
export class App {}
