import {
  ChangeDetectionStrategy,
  Component,
  ViewEncapsulation,
} from "@angular/core";
import { RouterLink } from "@angular/router";

/** Reserve the landing route while the inventory service is pending. */
@Component({
  selector: "berth-infrastructure",
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./infrastructure.html",
  styleUrl: "./infrastructure.css",
  encapsulation: ViewEncapsulation.None,
})
export class Infrastructure {}
