/** Saved bucket target for the bounded Retry provider check. */
export interface RetryTarget {
  region: string;
  namespace: string;
  compartment: string;
  bucket: string;
}

/** Closed provider observations. The database matches the scope and ownership tags. */
export type RetryObservation =
  | {
      kind: "present";
      id: string;
      etag: string;
      namespace: string;
      compartment: string;
      name: string;
      operation: string;
      marker: string;
      requestId: string;
      observedAt: string;
      configurationMatches: boolean;
    }
  | {
      kind:
        | "not-found"
        | "absent"
        | "inconclusive"
        | "ownership-conflict"
        | "read-access-unavailable";
    };

/** Read-only provider access required by Retry reconciliation. */
export interface RetryObserver {
  /** Check the target against the configured scope without making a provider request. */
  supports(target: RetryTarget): boolean;

  /**
   * Attempt at most one read before the absolute deadline in epoch milliseconds.
   * The caller must commit a reservation first. It records rejection as
   * inconclusive and retains the charge.
   */
  observe(
    target: RetryTarget,
    probe: "bucket" | "list",
    deadline: number,
  ): Promise<RetryObservation>;
}
