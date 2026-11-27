import { DatePipe, DecimalPipe } from "@angular/common";
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
  ViewEncapsulation,
} from "@angular/core";
import type { HostingUsageRow } from "../../hosting-usage-model";

/** Meters displayed together for one provider service and scope. */
interface UsageGroup {
  label: string;
  rows: HostingUsageRow[];
}

/** Present dated hosting allowances and emit the owner's selected summary file. */
@Component({
  selector: "berth-hosting-usage",
  imports: [DatePipe, DecimalPipe],
  templateUrl: "./hosting-usage.html",
  styleUrl: "./hosting-usage.css",
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
})
export class HostingUsage {
  readonly verified = input.required<boolean>();
  readonly targetConfigured = input.required<boolean>();
  readonly rows = input.required<HostingUsageRow[]>();
  readonly status = input.required<"idle" | "loading" | "loaded" | "failed">();
  readonly summary = output<File>();

  protected readonly sources = {
    "cloudflare-account-console":
      "Owner-recorded · Cloudflare Workers & Pages → Overview → Requests today",
    "neon-project-console": "Owner-recorded · Neon project Overview → Usage",
    "neon-organization-console":
      "Owner-recorded · Neon organization Projects → Usage",
    "neon-project-api": "Neon project management API (approximate, may lag)",
  };

  protected readonly groups = computed(() => {
    const groups = new Map<string, UsageGroup>();
    for (const row of this.rows()) {
      const label = `${row.service} · ${row.scope}`;
      const group = groups.get(label);
      if (group) {
        group.rows.push(row);
      } else {
        groups.set(label, { label, rows: [row] });
      }
    }
    return Array.from(groups.values());
  });

  /** Round a derived lower bound down at the precision used in the display. */
  protected conservativeHeadroom(remaining: number) {
    return Math.floor(remaining * 100_000_000) / 100_000_000;
  }

  /** Pass the file to Infrastructure and allow the same filename on a later refresh. */
  protected select(control: HTMLInputElement) {
    const file = control.files?.[0];
    if (file) {
      this.summary.emit(file);
    }
    control.value = "";
  }
}
