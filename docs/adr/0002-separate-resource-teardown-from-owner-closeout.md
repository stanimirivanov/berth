# Separate resource teardown from owner closeout

Berth gives the executor bounded authority to remove the operation's owned bucket
and object. The owner separately removes schedules, deployment secrets,
credentials and dedicated identity resources. Keeping administrative permissions
with the owner limits the executor's authority while preserving an independent
recovery path if hosted execution stops.

A closeout receipt records the administrative action it proves. Hosting can be
closed while resource reconciliation remains open. Within the operation window,
recovery is subject to the original ownership checks and cleanup reserve. Resource
removal after expiry requires separate owner authorization and evidence. A later
manual removal is recorded separately from the autonomous teardown acceptance
criterion and grants no new capacity under the original operation.

See [shutdown responsibilities](../../SPEC.md#shutdown-responsibilities),
[owner recovery](../trial/owner-recovery.md) and the
[read-only reconciliation report](../trial/reconciliation83.md).
