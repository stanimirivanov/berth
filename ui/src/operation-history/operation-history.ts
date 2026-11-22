import { DatePipe } from "@angular/common";
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  type OnInit,
} from "@angular/core";
import { ActivatedRoute } from "@angular/router";
import { HistoryStore } from "./history-store";

/** Read-only history screen. The shell holds accepted access in tab memory. */
@Component({
  selector: "berth-operation-history",
  imports: [DatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./operation-history.html",
})
export class OperationHistory implements OnInit {
  protected readonly operation =
    inject(ActivatedRoute).snapshot.paramMap.get("operation");
  protected readonly store = inject(HistoryStore);
  protected readonly selection = computed(() => {
    const selected = this.store.selected();
    return this.operation === null || selected?.operation === this.operation
      ? selected
      : null;
  });
  protected token = "";
  protected readonly meters = [
    { key: "normal", label: "Normal Object Storage" },
    { key: "cleanup", label: "Cleanup Object Storage" },
    { key: "monitoring", label: "Monitoring" },
    { key: "neon", label: "Neon application" },
  ] as const;

  /** Load a newly entered view while keeping failed reads available for manual retry. */
  ngOnInit() {
    if (!this.store.connected() || this.store.error()) {
      return;
    }
    if (this.operation !== null) {
      if (!this.selection()) {
        this.store.select(this.operation);
      }
    } else if (!this.store.loaded() && this.store.selected()) {
      this.store.refresh();
    }
  }

  /** Refresh the view identified by the route. */
  protected refresh() {
    if (this.operation === null) {
      this.store.refresh();
    } else {
      this.store.select(this.operation);
    }
  }

  protected connect(event: Event) {
    event.preventDefault();
    this.store.connect(this.token, this.operation);
    this.token = "";
  }
  protected disconnect() {
    this.token = "";
    this.store.disconnect();
  }
}
