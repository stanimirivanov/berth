import { DatePipe } from "@angular/common";
import {
  ChangeDetectionStrategy,
  Component,
  effect,
  inject,
  signal,
  untracked,
  ViewEncapsulation,
} from "@angular/core";
import { MatButtonModule } from "@angular/material/button";
import { MatCard } from "@angular/material/card";
import { MatFormFieldModule } from "@angular/material/form-field";
import { MatInputModule } from "@angular/material/input";
import { MatListModule } from "@angular/material/list";
import { MatProgressBarModule } from "@angular/material/progress-bar";
import { RouterLink } from "@angular/router";
import { OWNER_SESSION } from "../owner-access/owner-session";
import { offerings } from "./catalog";
import { HostingUsage } from "./components/hosting-usage/hosting-usage";
import { InventoryInstance } from "./components/inventory-instance/inventory-instance";
import { InventoryStore } from "./inventory-store";
import { UsageStore } from "./usage-store";

/** Present the public catalog and coordinate protected reads for the landing page. */
@Component({
  selector: "berth-infrastructure",
  imports: [
    DatePipe,
    HostingUsage,
    InventoryInstance,
    MatButtonModule,
    MatCard,
    MatFormFieldModule,
    MatInputModule,
    MatListModule,
    MatProgressBarModule,
    RouterLink,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./infrastructure.html",
  styleUrl: "./infrastructure.css",
  encapsulation: ViewEncapsulation.None,
})
export class Infrastructure {
  protected readonly owner = inject(OWNER_SESSION);
  protected readonly store = inject(InventoryStore);
  protected readonly usage = inject(UsageStore);
  protected readonly offerings = offerings;
  protected readonly token = signal("");

  constructor() {
    effect(() => {
      if (this.owner.canRead()) {
        untracked(() => this.store.open());
      }
    });
  }

  /** Clear the form value after passing it to the tab-memory owner session. */
  protected connect(event: Event) {
    event.preventDefault();
    this.owner.connect(this.token());
    this.token.set("");
  }
}
