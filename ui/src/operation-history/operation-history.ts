import { DatePipe } from "@angular/common";
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  untracked,
  ViewEncapsulation,
} from "@angular/core";
import { toSignal } from "@angular/core/rxjs-interop";
import { ActivatedRoute, Router, RouterLink } from "@angular/router";
import { HistoryStore, isOperationId } from "./history-store";

/** Read-only history screen. The shell holds accepted access in tab memory. */
@Component({
  selector: "berth-operation-history",
  imports: [DatePipe, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./operation-history.html",
  styleUrl: "./operation-history.css",
  encapsulation: ViewEncapsulation.None,
})
export class OperationHistory {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  protected readonly store = inject(HistoryStore);
  private readonly segments = toSignal(this.route.url, { requireSync: true });
  private readonly operation = computed(() => this.segments()[1]?.path ?? null);
  protected readonly invalidOperation = computed(() => {
    const operation = this.operation();
    return (
      operation !== null &&
      (!isOperationId(operation) ||
        this.segments().some(
          (segment) => Object.keys(segment.parameters).length > 0,
        ))
    );
  });
  protected readonly emptyList = computed(
    () => this.store.list()?.items.length === 0,
  );
  protected readonly showDetail = computed(() => {
    const selection = this.store.operation();
    const operation = this.operation();
    return (
      selection !== null && (operation === null || operation === selection)
    );
  });
  protected token = "";
  protected readonly meters = [
    { key: "normal", label: "Normal Object Storage" },
    { key: "cleanup", label: "Cleanup Object Storage" },
    { key: "monitoring", label: "Monitoring" },
    { key: "neon", label: "Neon application" },
  ] as const;

  /** React to route changes without reopening the view when read state changes. */
  constructor() {
    effect(() => {
      const operation = this.operation();
      const valid = !this.invalidOperation();
      untracked(() => {
        if (valid) {
          this.store.open(operation);
        } else {
          this.store.select(null);
        }
      });
    });
  }

  /** Keep the saved URL in sync when selecting another record from that view. */
  protected select(operation: string) {
    if (this.operation() === null) {
      this.store.select(operation);
    } else {
      void this.router.navigate(["/operations", operation]);
    }
  }

  protected connect(event: Event) {
    event.preventDefault();
    this.store.connect(this.token, this.operation());
    this.token = "";
  }
  protected disconnect() {
    this.token = "";
    this.store.disconnect();
  }
}
