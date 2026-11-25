import { DatePipe } from "@angular/common";
import {
  afterRenderEffect,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  ElementRef,
  effect,
  inject,
  signal,
  untracked,
  ViewEncapsulation,
  viewChild,
  viewChildren,
} from "@angular/core";
import { toSignal } from "@angular/core/rxjs-interop";
import { MatButtonModule } from "@angular/material/button";
import { MatCard } from "@angular/material/card";
import { MatFormFieldModule } from "@angular/material/form-field";
import { MatInputModule } from "@angular/material/input";
import {
  MatListItem,
  MatListItemLine,
  MatListItemTitle,
  MatNavList,
} from "@angular/material/list";
import { MatProgressBarModule } from "@angular/material/progress-bar";
import { ActivatedRoute, RouterLink } from "@angular/router";
import { isOperationId } from "../operation-id";
import { OWNER_SESSION } from "../owner-access/owner-session";
import { activeExpiry, attentionReasons, ownerProcedures } from "./attention";
import type { Operation } from "./history-reader";
import { HistoryStore } from "./history-store";
import { RetryPanel } from "./retry/retry-panel";

/** Read-only history screen. The shell holds accepted access in tab memory. */
@Component({
  selector: "berth-operation-history",
  imports: [
    DatePipe,
    RouterLink,
    MatButtonModule,
    MatCard,
    MatFormFieldModule,
    MatInputModule,
    MatListItem,
    MatListItemLine,
    MatListItemTitle,
    MatNavList,
    MatProgressBarModule,
    RetryPanel,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./operation-history.html",
  styleUrl: "./operation-history.css",
  encapsulation: ViewEncapsulation.None,
})
export class OperationHistory {
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);
  protected readonly store = inject(HistoryStore);
  protected readonly owner = inject(OWNER_SESSION);
  private readonly segments = toSignal(this.route.url, { requireSync: true });
  protected readonly operation = computed(
    () => this.segments()[1]?.path ?? null,
  );
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
  protected readonly showDetail = computed(() => this.operation() !== null);
  private readonly inboxHeading =
    viewChild<ElementRef<HTMLElement>>("inboxHeading");
  private readonly detailHeading =
    viewChild<ElementRef<HTMLElement>>("detailHeading");
  private readonly rows = viewChildren("operationRow", {
    read: ElementRef<HTMLAnchorElement>,
  });
  private previousFocusRoute: string | null | undefined;
  private restoredRow: HTMLAnchorElement | undefined;
  private readonly now = signal(Date.now());
  private readonly expiryTick = signal(0);

  protected readonly groups = computed(() => {
    const attention: Operation[] = [];
    const other: Operation[] = [];
    for (const operation of this.store.list()?.items ?? []) {
      const group = attentionReasons(operation, this.now()).length
        ? attention
        : other;
      group.push(operation);
    }
    return [
      { label: "Needs attention", items: attention },
      { label: "Other operations", items: other },
    ];
  });

  protected readonly detailLoading = computed(
    () =>
      this.store.operation() !== this.operation() || this.store.detailLoading(),
  );
  protected readonly detailFailure = computed(() =>
    this.store.operation() === this.operation()
      ? this.store.detailFailure()
      : null,
  );
  protected readonly detail = computed(() => {
    const result = this.store.detail();
    return result?.record.operation === this.operation() ? result : null;
  });
  protected readonly reasons = computed(() => {
    const detail = this.detail();
    return detail ? attentionReasons(detail.record, this.now()) : [];
  });

  protected readonly retryOriginalExpired = computed(() => {
    const detail = this.detail();
    return detail !== null && Date.parse(detail.record.expiresAt) <= this.now();
  });

  protected readonly recoveryLinks = computed(() => {
    const procedures = new Set(
      this.reasons().map((reason) => reason.procedure),
    );
    return Array.from(procedures, (procedure) => ownerProcedures[procedure]);
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
    this.destroyRef.onDestroy(() => this.store.leave());
    effect(() => {
      const operation = this.operation();
      const valid = !this.invalidOperation();
      untracked(() => {
        if (valid) {
          this.store.open(operation);
        } else {
          this.store.leave();
          this.store.select(null);
        }
      });
    });
    // Only record changes or the expiry timer reschedule the local clock.
    effect((onCleanup) => {
      this.expiryTick();
      const now = Date.now();
      const operations = this.store.list()?.items ?? [];
      const selected = this.store.detail()?.record;
      const visible = selected ? [...operations, selected] : operations;
      const deadlines = visible
        .map(activeExpiry)
        .filter((expiry): expiry is number => expiry !== null && expiry > now);
      this.now.set(now);
      if (deadlines.length) {
        // Recheck locally at the next expiry. Do not refresh the history API.
        const delay = Math.min(2_147_483_647, Math.min(...deadlines) - now);
        const timer = setTimeout(
          () => this.expiryTick.update((tick) => tick + 1),
          delay,
        );
        onCleanup(() => clearTimeout(timer));
      }
    });
    afterRenderEffect(() => this.restoreFocus());
  }

  /** Restore focus after route and pane state agree, including a regrouped row. */
  private restoreFocus() {
    if (!this.owner.canRead() || this.invalidOperation()) {
      this.previousFocusRoute = undefined;
      this.restoredRow = undefined;
      return;
    }
    const operation = this.operation();
    if (operation !== this.store.operation()) {
      return;
    }
    const rows = this.rows().map((row) => row.nativeElement);
    if (operation === this.previousFocusRoute) {
      const previousRow = this.restoredRow;
      if (
        previousRow &&
        !previousRow.isConnected &&
        previousRow.ownerDocument.activeElement ===
          previousRow.ownerDocument.body
      ) {
        this.restoredRow = rows.find((row) => row.id === previousRow.id);
        (this.restoredRow ?? this.inboxHeading()?.nativeElement)?.focus();
      }
      return;
    }
    const previous = this.previousFocusRoute;
    this.restoredRow = operation
      ? undefined
      : rows.find((row) => row.id === previous);
    const target = operation
      ? this.detailHeading()?.nativeElement
      : (this.restoredRow ?? this.inboxHeading()?.nativeElement);
    if (target) {
      this.previousFocusRoute = operation;
      target.focus();
    }
  }

  /** Submit a valid owner token and open the requested History view. */
  protected connect(event: Event) {
    event.preventDefault();
    if (this.owner.connect(this.token)) {
      this.store.open(this.operation());
    }
    this.token = "";
  }
  /** Clear the shared owner session and its protected feature data. */
  protected disconnect() {
    this.token = "";
    this.owner.disconnect();
  }
}
