# Make operation history a read-only owner console

The first release will help the owner review operations and identify follow-up.
Keep authorization, reconciliation and cleanup actions in the existing owner
procedures. This lets the owner inspect a retained operation after expiry while
preserving the executor's authorization and cleanup reserve. The trial's
partial/no-go feasibility verdict remains visible separately from operation
outcomes and follow-up indicators.

## Navigation and detail

- Operation history is the landing screen at `/`. A selection opens
  `/operations/:operation`. Keep the list and detail side by side on desktop and
  give detail the full width on mobile, with a way back to the list.
- A valid saved link prompts for the history token when needed and opens the
  requested operation after access is granted. The browser URL carries only the
  operation ID. A malformed ID shows **Invalid operation link** and a way back
  to history without making a history API request for that URL.
- Show **Needs attention** separately from the recorded outcome in the list.
  In detail, lead with all applicable reasons. Put an expired window with
  recorded outcome `active` first, then explain `needs-reconciliation` and any
  unresolved requests or mutations that apply. Expiry leaves the recorded
  outcome intact.
- Link uncertainty to the [owner recovery evidence
  checks](../trial/owner-recovery.md#2-save-a-read-only-sql-snapshot-before-every-local-action).
  Link expiry to the [stop conditions](../trial/owner-recovery.md#4-stop-conditions-and-leftovers).
  The procedure's cleanup steps require the original window to be open and all
  recovery prerequisites to hold.
- Follow with recorded lifecycle state, execution window, unresolved work and
  application request budgets. Keep these fields available even when the
  operation needs no attention. A cleanup request records intent. Verified
  resource teardown and owner closeout require their own evidence.

See the [history API and access decision](0005-use-existing-history-api-with-independent-read-states.md)
and the [resource teardown and owner closeout decision](0002-separate-resource-teardown-from-owner-closeout.md).
