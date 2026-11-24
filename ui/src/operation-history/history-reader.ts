import { InjectionToken } from "@angular/core";
import type { OwnerRead } from "../owner-access/owner-session";

/** Browser-only allowlist; app counters are never provider allowances. */
export interface Operation {
  operation: string;
  startedAt: string;
  expiresAt: string;
  outcome: string;
  phase: string | null;
  pendingUpload: boolean;
  cleanupRequested: boolean;
  objectRemoved: boolean;
  verdict: "partial";
  budgets: Record<
    "normal" | "cleanup" | "monitoring" | "neon",
    { used: number; limit: number }
  >;
  unresolved: { requests: number; mutations: number };
}

/** A bounded History page with the cursor for reading the next older page. */
export interface HistoryPage {
  items: Operation[];
  next: string | null;
}

/** Forward isCurrent to Owner access so obsolete replies cannot verify the session. */
export interface HistoryReader {
  /** Read the newest page or continue from the retained cursor. */
  list(
    before: string | null,
    isCurrent: () => boolean,
  ): Promise<OwnerRead<HistoryPage>>;
  /** Read exactly the selected operation. */
  detail(
    operation: string,
    isCurrent: () => boolean,
  ): Promise<OwnerRead<Operation>>;
}

/** The shell provides the same-origin implementation for the History store. */
export const HISTORY_READER = new InjectionToken<HistoryReader>(
  "History reader",
);
