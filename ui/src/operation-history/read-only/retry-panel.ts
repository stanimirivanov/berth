import {
  ChangeDetectionStrategy,
  Component,
  input,
  ViewEncapsulation,
} from "@angular/core";

/** History's inactive Retry slot in the read-only build. */
@Component({
  selector: "berth-retry-panel",
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./retry-panel.html",
  styleUrl: "./retry-panel.css",
  encapsulation: ViewEncapsulation.None,
})
export class RetryPanel {
  static readonly accessLabel = null;
  readonly operation = input.required<string>();
  readonly originalExpired = input.required<boolean>();
  readonly originalCleanup = input.required<boolean>();
}
