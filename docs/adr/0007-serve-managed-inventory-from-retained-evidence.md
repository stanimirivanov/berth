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

## Initial inventory and coverage

- Seed the inventory from retained evidence that matches a specific
  Berth-managed resource identity. A name-only observation, lifecycle outcome,
  or generic mutation settlement leaves a coverage gap when the evidence
  cannot establish identity or what happened. Keep unmatched evidence
  available for reconciliation without creating an instance row.
- Keep an identified instance **Uncertain** while its create or delete is
  unresolved. Apply uncertainty to the resource affected by the unresolved
  change. For example, an unresolved object upload does not change a dated
  verified observation of the containing bucket.
- Use admitted resource-specific removal evidence from the executor or an
  independent owner procedure to clear that instance from the current
  inventory. A complete listing can corroborate removal when it matches the
  identity's recorded scope. A standalone absence response or closeout
  summary cannot clear an identifiable instance.
- Assess coverage per offering across all relevant retained Berth operations.
  A successful zero-row response supports **No known instances** only when
  that scope is accounted for and no present or uncertain instances remain.
  Use **Inventory coverage incomplete** when a gap remains. Show qualified
  instance rows alongside the gap. The inventory describes Berth-managed
  resources within its recorded scope.

The [November 15 trial report](../trial/live-results.md) documents a conditional
delete for the saved bucket and the complete listing that corroborated it.
The [November 20 reconciliation](../trial/reconciliation83.md) records matching
ownership and a present bucket at its observation time while the object upload
remained unresolved. The reports document dated observations. Qualifying a seed
requires the retained identity-bound evidence behind them. Preserve that
evidence and the original operation outcomes.

## Read states

- Keep offerings visible while inventory loads or is unavailable. An
  unavailable response provides no count. A successful response can report
  complete or incomplete coverage.
- On refresh failure, retain the last successful rows with their browser fetch
  time, a stale-data warning and **Retry**. The fetch time is separate from each
  row's last verified provider observation.
- On access denial, clear the token and protected records across both screens
  and discard pending replies from the old access state. Keep the current URL
  and request a valid token after `401`. After `403`, direct the owner to the
  configured Berth URL. See [ADR 0005](0005-use-existing-history-api-with-independent-read-states.md).

## Read-only release readiness

A read-only release can proceed with known coverage gaps when the UI identifies
every affected offering, shows the evidence-backed instances it does have, and
distinguishes incomplete coverage from a verified empty inventory. The release
record must say what is missing and how the owner can reconcile it. A UI that
cannot make that distinction makes the inventory release a no-go. Apply the
other release checks independently. Preserve the historical partial/no-go
verdict and the existing owner cleanup and authorization boundaries.
