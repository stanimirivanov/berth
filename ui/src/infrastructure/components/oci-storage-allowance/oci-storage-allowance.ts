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
import {
  type MonthlyGap,
  type MonthlyMeter,
  monthlyAllowance,
  outboundZones,
  type StorageSnapshot,
} from "../../../../contracts/oci-storage";

const monthlyMeters = [
  {
    meter: "requests",
    title: "OCI Object Storage API requests",
    unit: "requests",
    divisor: 1,
  },
  {
    meter: "outbound",
    title: "OCI outbound transfer",
    unit: "GB",
    divisor: 1_000,
  },
] as const;

/** Use the same warning thresholds for each qualified OCI allowance reading. */
function warningBand(used: number, limit: number) {
  const fraction = used / limit;
  if (fraction >= 1) {
    return "Limit reached (100% threshold reached)";
  }
  if (fraction >= 0.95) {
    return "Near limit (95% threshold reached)";
  }
  return fraction >= 0.8 ? "Approaching limit (80% threshold reached)" : null;
}

/** Summarize the latest settled gap without implying that any unreported usage was zero. */
function monthlyGapMessage(
  meter: MonthlyMeter,
  gap: MonthlyGap | null | undefined,
) {
  switch (gap) {
    case "account-unverified":
      return "Always Free account eligibility could not be verified.";
    case "oci-unavailable":
      return "OCI could not provide a monthly usage reading.";
    case "response-time-unverified":
      return "OCI did not return a current response time.";
    case "usage-coverage-unverified":
      return meter === "requests"
        ? "OCI did not report verified tenancy-wide request usage for this period."
        : "OCI did not report verified usage for the applicable outbound allowance.";
    case "outbound-scope-unverified":
      return "OCI reported multiple outbound pricing zones.";
    case "accounting-cutoff-unverified":
      return "OCI reports usage without a verified accounting cutoff.";
    case null:
      return null;
    default:
      return "No qualifying OCI monthly reading has been saved.";
  }
}

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
  readonly clock = input.required<number>();
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
  protected readonly previousCollectionStale = computed(() => {
    const pending = this.pending();
    return (
      this.overdue() ||
      pending?.startedAt === null ||
      pending?.previousObservationStale === true
    );
  });
  protected readonly stale = computed(() => {
    const value = this.reading();
    const gap = this.snapshot()?.gap;
    return (
      value !== null &&
      (this.unavailable() ||
        this.expired() ||
        this.previousCollectionStale() ||
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
    return warningBand(value.usedBytes, value.limitBytes);
  });

  protected readonly monthly = computed(() =>
    monthlyMeters.map((display) => {
      const outcome = this.snapshot()?.monthly?.[display.meter];
      const value = outcome?.reading ?? null;
      const cutoff = value?.accountingCutoff ?? null;
      const previousPeriod =
        value && this.clock() >= Date.parse(value.periodEnd);
      const expired = value && this.clock() >= Date.parse(value.expiresAt);
      const gap = outcome?.gap;
      const stale =
        value &&
        (this.unavailable() ||
          expired ||
          this.previousCollectionStale() ||
          (gap != null &&
            (gap !== "accounting-cutoff-unverified" || cutoff !== null)));
      const limit = monthlyAllowance[display.meter];
      const current = value && cutoff !== null && !stale;
      let reason = monthlyGapMessage(display.meter, gap);
      if (this.unavailable()) {
        reason = "Saved OCI monthly evidence could not be read.";
      } else if (previousPeriod) {
        reason = "Previous billing period.";
      } else if (expired) {
        reason = "The saved OCI reading has expired.";
      }
      return {
        ...display,
        value,
        status: stale ? "Stale" : current ? "Current" : "Unknown",
        reason,
        zone: value && value.sku !== "B91627" ? outboundZones[value.sku] : null,
        remaining: current
          ? Math.max(0, limit - value.used) / display.divisor
          : null,
        warning: current ? warningBand(value.used, limit) : null,
      };
    }),
  );
}
