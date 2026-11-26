import { DatePipe } from "@angular/common";
import {
  afterRenderEffect,
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  inject,
  input,
  ViewEncapsulation,
  viewChild,
} from "@angular/core";
import { MatButtonModule } from "@angular/material/button";
import { MatFormFieldModule } from "@angular/material/form-field";
import { MatInputModule } from "@angular/material/input";
import {
  canCheckProvider,
  continuationProcedure,
  reasons,
  recoveryStop,
  stageLabels,
  stepLabels,
} from "./retry-contract";
import { RetryStore } from "./retry-store";

/** Owner-only Retry controls scoped to one History detail. */
@Component({
  selector: "berth-retry-panel",
  imports: [DatePipe, MatButtonModule, MatFormFieldModule, MatInputModule],
  providers: [RetryStore],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./retry-panel.html",
  styleUrl: "./retry-panel.css",
  encapsulation: ViewEncapsulation.None,
})
export class RetryPanel {
  static readonly accessLabel = "Retry access";
  protected readonly store = inject(RetryStore);
  readonly operation = input.required<string>();
  readonly originalExpired = input.required<boolean>();
  readonly originalCleanup = input.required<boolean>();
  protected readonly checkAvailable = computed(() =>
    canCheckProvider(this.store.snapshot(), this.originalExpired()),
  );
  protected readonly blockedByCleanup = computed(() => {
    const current = this.store.snapshot();
    return (
      this.originalCleanup() &&
      current &&
      "reason" in current &&
      current.reason === "original-authority-unavailable"
    );
  });
  protected readonly ownerLink = computed(() => {
    const current = this.store.snapshot();
    if (
      current &&
      "reason" in current &&
      current.reason === "original-authority-unavailable"
    ) {
      return recoveryStop;
    }
    return current && "ownerProcedure" in current
      ? current.ownerProcedure
      : null;
  });
  protected readonly busyLabel = {
    checking: "Checking provider",
    approving: "Recording approval…",
    reading: "Checking retry status…",
  } as const;
  protected readonly stageLabels = stageLabels;
  protected readonly stepLabels = stepLabels;
  protected readonly reasons = reasons;
  protected readonly procedure = continuationProcedure;
  protected readonly message = {
    invalid: "Enter the separate Retry owner credential.",
    denied:
      "Retry access denied. Sign in again to recover the recorded status.",
    forbidden:
      "Retry access is blocked on this site. Open the configured Berth URL.",
    "session-expired":
      "The Retry session expired. Sign in again to recover the recorded status.",
    unavailable:
      "Retry status is unavailable. Check status before taking any action.",
    "result-unknown":
      "The response was interrupted. Check retry status before taking another action.",
    "proposal-changed":
      "The previous proposal is no longer current. Review the latest status.",
  } as const;
  private readonly credentialField =
    viewChild<ElementRef<HTMLInputElement>>("retryCredential");
  private readonly heading = viewChild<ElementRef<HTMLElement>>("heading");
  private readonly launch = viewChild("launch", {
    read: ElementRef<HTMLButtonElement>,
  });

  private returnFocus = false;

  /** Focus the separate credential prompt when it opens or must be entered again. */
  constructor() {
    afterRenderEffect(() => this.credentialField()?.nativeElement.focus());
    afterRenderEffect(() => {
      const launch = this.launch()?.nativeElement;
      if (launch && this.returnFocus) {
        this.returnFocus = false;
        launch.focus();
      }
    });
    afterRenderEffect(() => {
      // A busy, expired, or replaced action can remove the focused control.
      this.store.busy();
      this.store.notice();
      this.store.snapshot();
      const heading = this.heading()?.nativeElement;
      if (
        heading?.ownerDocument.activeElement === heading?.ownerDocument.body
      ) {
        heading?.focus();
      }
    });
  }

  /** Clear the DOM input before starting the action session. */
  protected signIn(event: Event, field: HTMLInputElement) {
    event.preventDefault();
    const credential = field.value;
    field.value = "";
    void this.store.connect(this.operation(), credential);
  }

  /** Return keyboard focus to Retry provisioning when its panel is closed. */
  protected close() {
    this.returnFocus = true;
    this.store.close();
  }
}
