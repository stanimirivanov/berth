# Reconcile in Berth and admit independent owner evidence

Berth records provider evidence automatically when it reconciles a provisioning
attempt. Alchemy can resume from durable state, but an OCI mutation and its
Neon checkpoint can succeed or fail independently. A separate owner-only intake
lets Infrastructure reflect verified observations when Berth could not complete
reconciliation or cleanup.

## Retry provisioning

Retry the same operation. Use retained intent and request records to check the
provider, record what was established, and continue from the last verified step
when authorized. If the exact owned bucket exists, continue with that instance.
An empty listing after a timed-out create cannot establish that the request
will never complete. Issue another create only when the earlier request can no
longer create the bucket or the provider explicitly guarantees safe replay for
that request. If ownership or the prior outcome remains unresolved, show
**Needs attention** and preserve the evidence.

After the execution window expires, Berth can offer read-only reconciliation
under a separate bounded scope. A further provider write needs fresh
authorization as well as the same retry safety checks. Preserve the expired
operation's outcome, cutoff, request accounting and cleanup reserve.
See [ADR 0001](0001-separate-execution-authority-from-provider-evidence.md).

## Independent owner evidence

When Berth cannot complete reconciliation or cleanup, the owner can submit a
private provider receipt from the independently authorized procedure. Berth's
intake command has permission limited to recording evidence. It performs no OCI
calls and grants no execution or cleanup authority. The browser history token
continues to grant read access only.

Bind each receipt to the saved operation and its scope, the exact OCI bucket
identity, a stable source reference, and the provider observation time. Keep the
source evidence and identity details private. Use provider time for projection
and retain the original receipt when admission is rejected or a conflict needs
review. Inventory reads expose the [approved summary](0007-serve-managed-inventory-from-retained-evidence.md).

| Submitted evidence | Result |
| --- | --- |
| Authenticated observation with the exact OCI bucket ID, matching recorded scope and ownership markers | Record dated verified presence for the owned instance |
| Successful conditional delete of the exact owned revision, with authenticated absence and a complete matching scoped listing | Record verified removal and clear that instance from Infrastructure |
| Typed confirmation, standalone OCI `404`, incomplete listing, or identity or scope mismatch | Preserve for review without changing inventory |
| Replay of the same source reference with the same evidence | Return **Already recorded** and leave inventory unchanged |
| Valid older presence submitted after a later verified removal | Preserve the older observation without restoring the row |
| Changed evidence under the same source reference, contradictory observations at the same time, or purported later presence of the same OCI ID after verified removal | Flag for reconciliation and preserve the last verified projection |

A reused name with a different OCI bucket ID represents a different instance
and requires its own ownership evidence. Recording a receipt leaves the
operation outcome and original request accounting intact. Verified owner
removal leaves the autonomous teardown criterion and historical partial/no-go
verdict intact. See [ADR 0002](0002-separate-resource-teardown-from-owner-closeout.md)
and the [owner reconciliation example](../trial/reconciliation83.md).

[M02-PR2](https://github.com/stanimirivanov/berth/issues/117) owns executor and
independent owner evidence intake. A separate delivery task owns the
user-facing Retry provisioning action and its authorization flow.
