import { DatePipe } from "@angular/common";
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  ViewEncapsulation,
} from "@angular/core";
import { MatListModule } from "@angular/material/list";
import { RouterLink } from "@angular/router";
import type { InventoryInstance as RetainedInstance } from "../../inventory-model";

/** Present the last retained evidence and link to the operation that recorded it. */
@Component({
  selector: "berth-inventory-instance",
  imports: [DatePipe, MatListModule, RouterLink],
  templateUrl: "./inventory-instance.html",
  styleUrl: "./inventory-instance.css",
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
})
export class InventoryInstance {
  readonly instance = input.required<RetainedInstance>();
  protected readonly reviewLabel = computed(
    () => `Review operation for ${this.instance().displayName}`,
  );
}
