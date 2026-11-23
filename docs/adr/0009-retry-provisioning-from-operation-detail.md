# Retry provisioning from operation detail

Retry provisioning starts from **Needs attention** on the existing operation
detail. Uncertain Infrastructure rows link there. This keeps the operation,
its evidence and any proposed next steps together. The read-only Infrastructure
and Operation history release keeps the access boundaries in
[ADR 0004](0004-make-operation-history-a-read-only-owner-console.md).
Retry is a separate capability with its own owner sign-in and authorization.

## Reconcile before continuing

- A short-lived owner sign-in unlocks retry controls and a separately bounded
  provider check. The history token grants read access only. Provider
  credentials stay on the server. Retry and its status are tied to the saved
  operation.
- Within the original execution window, continue using the work it still
  authorizes. If creation authority has ended or cleanup has started, explain
  the stop and link the relevant [owner procedure](../trial/owner-recovery.md).
- After expiry, Berth checks the provider under a fresh read-only scope with its
  own accounting. Record what the checks established using the inventory
  evidence rules. The expired operation's cutoff, outcome, budgets and cleanup
  reserve remain intact. Preserve the historical partial/no-go verdict.
- A verified exact owned bucket allows continuation with that instance. An
  unresolved earlier write or disputed ownership leaves **Needs attention**.
  Another create requires evidence that the earlier request can no longer
  create the bucket or an explicit provider guarantee of safe replay.
  See [ADR 0008](0008-reconcile-in-berth-and-admit-independent-owner-evidence.md).

## Approve further writes after expiry

When a write is safe and necessary, qualify the proposed work under the
applicable Free evidence policy. Show the exact target, remaining steps,
proposed execution window, request limits and protected cleanup reserve.
If an allowance, credential or cleanup prerequisite fails qualification,
identify what is missing, show the relevant owner procedure and stop before
offering approval.

The proposal expires in five minutes. A change in target, evidence or allowance
checks requires a fresh proposal. Approval records one separate retry
authorization linked to the original operation. Repeated submission of the same
approval returns the same recorded continuation. Before dispatch, recheck
scope, ownership, authorization and whether the previous write can still
complete.

## Show durable progress

Show the latest retry stage alongside the original operation outcome. Use
**Checking provider**, **Waiting for approval**, **Continuing provisioning**,
**Completed** or **Needs attention** with the reason. After reload or a lost
response, recover the recorded retry before offering another action. Reading
status does not run a provider check or dispatch another write.

## Delivery order

1. [Bounded provider reconciliation and owner access](https://github.com/stanimirivanov/berth/issues/140)
2. [Authorization for safe continuation](https://github.com/stanimirivanov/berth/issues/141)
3. [Retry provisioning in operation detail](https://github.com/stanimirivanov/berth/issues/142)
