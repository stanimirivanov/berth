import { DatePipe } from "@angular/common";
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  type OnInit,
} from "@angular/core";
import { ActivatedRoute } from "@angular/router";
import { HistoryStore } from "./history.store";

/** Read-only history screen. The shell holds accepted access in tab memory. */
@Component({
  selector: "berth-operation-history",
  imports: [DatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
      <section class="intro"><p class="eyebrow">OCI Object Storage · Retained evidence</p><h1>Operation history</h1><p>Review lifecycle outcomes, spent request budgets and unresolved work.</p></section>
      <aside class="verdict" aria-label="Feasibility verdict"><strong>Partial / no-go</strong><p>A completed operation is not proof of full live validation. Provider usage and remaining free allowances are not shown here.</p></aside>
      <section class="access" aria-label="History access">
        @if (!store.connected()) {
          <form (submit)="connect($event)"><label for="token">History access token</label><div class="access-row"><input id="token" type="password" autocomplete="off" [value]="token" (input)="token = $any($event.target).value" maxlength="128" spellcheck="false"><button type="submit">Load history</button></div><small>Kept in memory for this tab. No database or cloud credentials.</small></form>
        } @else { <p>History access connected</p><div class="actions"><button (click)="refresh()" [disabled]="store.loading()">{{ operation === null ? 'Refresh history' : 'Refresh detail' }}</button><button class="secondary" (click)="disconnect()">Disconnect</button></div> }
      </section>
      @if (store.error()) { <p role="alert" class="error">{{ store.error() }}</p> }
      @if (operation !== null && store.loading()) { <p role="status">Loading operation details…</p> }
      @if (operation === null) {
      <section [attr.aria-busy]="store.loading()" aria-label="Recorded operations">
        @if (store.loading()) { <p role="status">Loading operation history…</p> }
        @if (store.loaded() && !store.loading() && !store.error() && store.items().length === 0) { <p role="status" class="empty">No recorded operations.</p> }
        @if (store.items().length) {
          <div class="section-heading"><h2>Recorded operations</h2><span>Newest first · UTC times</span></div>
          <ul class="operations">@for (item of store.items(); track item.operation) {
            <li><div><span class="status">{{ item.outcome }}</span><time>{{ item.startedAt | date:'medium':'UTC' }}</time></div><button class="operation-id" (click)="store.select(item.operation)" [disabled]="store.loading()">{{ item.operation }}</button><p>Phase: {{ item.phase ?? 'Not recorded' }} · Unresolved mutations: {{ item.unresolved.mutations }}</p></li>
          }</ul>
          <nav aria-label="History pagination"><button class="secondary" (click)="store.refresh()" [disabled]="store.loading()">Newest operations</button><button (click)="store.older()" [disabled]="store.loading() || !store.next()">Older operations</button></nav>
        }
      </section>
      }
      @if (selection(); as selected) {
        <section class="details" aria-label="Selected operation"><h2>Operation details</h2><p class="mono">{{ selected.operation }}</p><dl><dt>Lifecycle outcome</dt><dd>{{ selected.outcome }}</dd><dt>Phase</dt><dd>{{ selected.phase ?? 'Not recorded' }}</dd><dt>Execution expiry (UTC)</dt><dd>{{ selected.expiresAt | date:'medium':'UTC' }}</dd><dt>Cleanup requested</dt><dd>{{ selected.cleanupRequested ? 'Yes' : 'No' }}</dd><dt>Upload unresolved</dt><dd>{{ selected.pendingUpload ? 'Yes' : 'No' }}</dd><dt>Object removal recorded</dt><dd>{{ selected.objectRemoved ? 'Yes' : 'No' }}</dd></dl><p>Unresolved mutations: {{ selected.unresolved.mutations }}</p><p>Unresolved requests: {{ selected.unresolved.requests }}</p><h3>Application request budgets</h3><p>Spent / limit. These are not provider billing totals.</p><dl>@for (meter of meters; track meter.key) { <dt>{{ meter.label }}</dt><dd>{{ selected.budgets[meter.key].used }} / {{ selected.budgets[meter.key].limit }}</dd> }</dl>
        </section>
      }
  `,
})
export class OperationHistory implements OnInit {
  readonly operation =
    inject(ActivatedRoute).snapshot.paramMap.get("operation");
  readonly store = inject(HistoryStore);
  readonly selection = computed(() => {
    const selected = this.store.selected();
    return this.operation === null || selected?.operation === this.operation
      ? selected
      : null;
  });
  token = "";
  readonly meters = [
    { key: "normal", label: "Normal Object Storage" },
    { key: "cleanup", label: "Cleanup Object Storage" },
    { key: "monitoring", label: "Monitoring" },
    { key: "neon", label: "Neon application" },
  ] as const;

  /** Load a newly entered view while keeping failed reads available for manual retry. */
  ngOnInit() {
    if (!this.store.connected() || this.store.error()) return;
    if (this.operation !== null) {
      if (!this.selection()) this.store.select(this.operation);
    } else if (!this.store.loaded() && this.store.selected()) {
      this.store.refresh();
    }
  }

  /** Refresh the view identified by the route. */
  refresh() {
    if (this.operation === null) this.store.refresh();
    else this.store.select(this.operation);
  }

  connect(event: Event) {
    event.preventDefault();
    this.store.connect(this.token, this.operation);
    this.token = "";
  }
  disconnect() {
    this.token = "";
    this.store.disconnect();
  }
}
