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
  type MonthlyMeter,
  outboundZones,
  requestUsageSku,
  type StorageSnapshot,
} from "../../../../contracts/oci-storage";
import {
  type CollectionView,
  type MonthlyMeterView,
  warningThreshold,
} from "../../oci-allowance-model";

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

const warningMessage = {
  80: "Approaching limit (80% threshold reached)",
  95: "Near limit (95% threshold reached)",
  100: "Limit reached (100% threshold reached)",
};

/** Explain the monthly observation's status and the latest settled gap in owner-facing terms. */
function monthlyReasonMessage(
  meter: MonthlyMeter,
  reason: MonthlyMeterView["reason"],
) {
  switch (reason) {
    case "saved-read-unavailable":
      return "Saved OCI monthly evidence could not be read.";
    case "previous-period":
      return "Previous billing period.";
    case "expired":
      return "The saved OCI reading has expired.";
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
    case "no-reading":
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
  readonly collection = input.required<CollectionView | null>();
  readonly monthlyReadings =
    input.required<Record<MonthlyMeter, MonthlyMeterView>>();
  readonly unavailable = input.required<boolean>();
  readonly expired = input.required<boolean>();
  readonly loading = input.required<boolean>();
  readonly refresh = output<void>();

  protected readonly reading = computed(() => this.snapshot()?.reading ?? null);
  protected readonly pending = computed(
    () => this.snapshot()?.provenance?.pending,
  );
  protected readonly collectionMessage = computed(() => {
    const collection = this.loading() ? null : this.collection();
    switch (collection?.status) {
      case "unknown":
        return "Collection outcome unknown.";
      case "overdue":
        return "Collection overdue.";
      case "pending":
        return collection.previousObservationStale
          ? "Collection pending. Previous observations remain stale after an earlier unsettled collection."
          : "Collection pending.";
      default:
        return null;
    }
  });
  protected readonly stale = computed(() => {
    const value = this.reading();
    const gap = this.snapshot()?.gap;
    return (
      value !== null &&
      (this.unavailable() ||
        this.expired() ||
        this.collection()?.previousObservationStale === true ||
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
    const warning = warningThreshold(value.usedBytes, value.limitBytes);
    return warning === null ? null : warningMessage[warning];
  });

  protected readonly monthly = computed(() =>
    monthlyMeters.map((display) => {
      const { reading, status, reason, remaining, warning } =
        this.monthlyReadings()[display.meter];
      return {
        ...display,
        reading,
        status,
        reason: monthlyReasonMessage(display.meter, reason),
        zone:
          reading && reading.sku !== requestUsageSku
            ? outboundZones[reading.sku]
            : null,
        remaining: remaining === null ? null : remaining / display.divisor,
        warning: warning === null ? null : warningMessage[warning],
      };
    }),
  );
}
