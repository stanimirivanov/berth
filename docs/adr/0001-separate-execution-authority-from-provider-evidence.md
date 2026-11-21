# Separate execution authority from provider evidence

Berth uses PostgreSQL as the authority for an operation's identity, owner
authorization, execution window, claims, attempts, request reservations and
recorded outcome. Alchemy state supports resource lifecycle management. A change
in OCI is established through a definite provider response or admissible
reconciliation evidence. This split lets hosted work continue across deliveries
while preserving uncertainty when an external request outlives an execution claim.

Each scheduled delivery and claim has its own identity within the operation.
Commit the applicable reservation before dispatch. A lost response leaves the
reservation spent and the mutation unresolved. An expired claim or missing Alchemy
receipt cannot establish that an upload never happened. Establish ownership from
the precommitted intent and matching provider evidence before acting on a resource.

See the [operation ledger](../trial/operation-ledger.md),
[hosted admission](../trial/hosted-admission.md) and
[ownership rules](../../SPEC.md#ownership-and-conditional-mutations).
