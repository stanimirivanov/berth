import { DatePipe, DecimalPipe } from "@angular/common";
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
  ViewEncapsulation,
} from "@angular/core";
import { MatButtonModule } from "@angular/material/button";
import type { StorageSnapshot } from "../../../../contracts/oci-storage";

/** Present the tenancy-wide reading and let the owner reread the saved result. */
@Component({
  selector: "berth-oci-storage-allowance",
  imports: [DatePipe, DecimalPipe, MatButtonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./oci-storage-allowance.html",
  styleUrl: "./oci-storage-allowance.css",
  encapsulation: ViewEncapsulation.None,
})
export class OciStorageAllowance {
  readonly snapshot = input.required<StorageSnapshot | null>();
  readonly unavailable = input.required<boolean>();
  readonly expired = input.required<boolean>();
  readonly overdue = input.required<boolean>();
  readonly loading = input.required<boolean>();
  readonly refresh = output<void>();

  protected readonly reading = computed(() => this.snapshot()?.reading ?? null);
  protected readonly pending = computed(
    () => this.snapshot()?.provenance?.pending,
  );
  protected readonly collectionStatus = computed(() => {
    const attempt = this.pending();
    if (!attempt) {
      return null;
    }
    if (!attempt.startedAt) {
      return "Collection outcome unknown.";
    }
    return this.overdue() ? "Collection overdue." : "Collection pending.";
  });
  protected readonly stale = computed(() => {
    const value = this.reading();
    const gap = this.snapshot()?.gap;
    const pending = this.pending();
    return (
      value !== null &&
      (this.unavailable() ||
        this.expired() ||
        this.overdue() ||
        pending?.startedAt === null ||
        pending?.previousObservationStale ||
        (gap != null &&
          (gap !== "accounting-cutoff-unverified" ||
            value.accountingCutoff !== null)))
    );
  });
  protected readonly status = computed(() => {
    if (this.stale()) {
      return "Stale";
    }
    return this.reading()?.accountingCutoff ? "Current" : "Unknown";
  });
  protected readonly settledReason = computed(() => {
    switch (this.snapshot()?.gap) {
      case "account-unverified":
        return "Always Free account eligibility could not be verified.";
      case "region-coverage-unverified":
        return "OCI did not confirm that the home region covers the entire tenancy.";
      case "response-time-unverified":
        return "OCI did not return a current response time.";
      case "storage-coverage-unverified":
        return "OCI did not return a qualifying tenancy-wide storage byte count.";
      case "oci-unavailable":
        return "OCI could not provide a storage reading.";
      case "accounting-cutoff-unverified":
        return "OCI reports usage without an accounting cutoff.";
      default:
        return null;
    }
  });
  protected readonly reason = computed(() => {
    if (this.unavailable()) {
      return "Saved OCI storage evidence could not be read.";
    }
    if (this.expired()) {
      return "The saved OCI reading has expired.";
    }
    if (this.pending()) {
      return null;
    }
    return (
      this.settledReason() ??
      (this.reading()
        ? null
        : "No qualifying OCI storage reading has been saved.")
    );
  });
  protected readonly legacyAttempt = computed(() => {
    const value = this.snapshot();
    return value && !value.provenance && (value.gap || !value.reading)
      ? value.attemptedAt
      : null;
  });
  protected readonly gigabyte = 1_000_000_000;
  protected readonly remaining = computed(() => {
    const value = this.reading();
    return value?.accountingCutoff && !this.stale()
      ? Math.max(0, value.limitBytes - value.usedBytes) / this.gigabyte
      : null;
  });
  protected readonly warning = computed(() => {
    const value = this.reading();
    if (!value?.accountingCutoff || this.stale()) {
      return null;
    }
    const fraction = value.usedBytes / value.limitBytes;
    if (fraction >= 1) {
      return "Limit reached (100% threshold reached)";
    }
    if (fraction >= 0.95) {
      return "Near limit (95% threshold reached)";
    }
    return fraction >= 0.8 ? "Approaching limit (80% threshold reached)" : null;
  });
}
