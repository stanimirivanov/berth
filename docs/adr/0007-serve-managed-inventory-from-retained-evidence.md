# Serve managed inventory from retained evidence

Berth owns the catalog of implemented offerings. A separate, authenticated
read endpoint serves the inventory of Berth-managed instances. The backend
derives presence from retained provider evidence and serves the instance
summary. Angular displays those results. Opening or refreshing Infrastructure
performs no OCI calls. The catalog can still render when inventory is
unavailable, and the existing Operation history endpoints keep their contract.

## Presence and removal

- Track each instance by its specific resource identity. An operation outcome
  and a resource name alone cannot establish presence or ownership. See
  [ADR 0001](0001-separate-execution-authority-from-provider-evidence.md).
- Show **Verified present** with the observation time when retained evidence
  establishes presence and later evidence leaves it intact. An unresolved
  change affecting that instance's presence makes it **Uncertain**. Keep the
  last verified observation time and explain the newer uncertainty. A bucket
  observed at 10:00 followed by an unresolved delete at 10:05 is **Uncertain**
  with a last verified observation at 10:00.
- The executor and the independently authorized owner procedure can record
  evidence for the same instance. Remove the row from Infrastructure only after
  resource-specific verified removal is recorded. A cleanup request or a note
  that cleanup ran leaves possible leftovers visible. Retain the dated
  evidence and the recorded operation outcome in their respective records.
  See [ADR 0002](0002-separate-resource-teardown-from-owner-closeout.md) and
  [ADR 0003](0003-project-current-history-and-preserve-dated-evidence.md).
- Inventory reads grant no execution authority. Authorization, reconciliation
  and cleanup stay in the existing owner procedures, with the protected
  cleanup reserve intact.

## Read states

- Keep the offerings visible while inventory loads or is unavailable. Show
  **No known instances** only after a successful result establishes that the
  offering has no known instances. An unavailable response provides no count.
- On refresh failure, retain the last successful rows with their browser fetch
  time, a stale-data warning and **Retry**. The fetch time is separate from each
  row's last verified provider observation.
- On access denial, clear the token and protected records across both screens
  and discard pending replies from the old access state. Keep the current URL
  and request a valid token after `401`. After `403`, direct the owner to the
  configured Berth URL. See [ADR 0005](0005-use-existing-history-api-with-independent-read-states.md).
