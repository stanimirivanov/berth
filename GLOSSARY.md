# Berth

Berth evaluates whether a single owner can run and verify a bounded cloud
resource lifecycle on free plans.

## Infrastructure

**Infrastructure offering**
A kind of infrastructure Berth implements provisioning for, within its stated
qualification and operating limits.

**Infrastructure catalog**
The list of Berth's infrastructure offerings, including offerings with no
known managed resource instances.

**Managed resource instance**
One specific resource tracked under an offering through a Berth operation. Its
identity distinguishes it from other instances of that offering.

**Verified presence**
Presence of a specific managed resource instance established by provider
evidence at a recorded observation time.

**Uncertain presence**
A managed resource instance may exist, but its presence is unresolved. Earlier
verified observations still describe what was established at their own times.

**Inventory coverage**
How fully retained evidence accounts for the Berth operations that could affect
the managed resource instances of an offering.

**Inventory coverage gap**
A relevant operation or observation that retained evidence cannot account for
in the inventory. A resource observation without an established instance
identity leaves a coverage gap.

## Authorization and execution

**Trial**
A feasibility experiment with defined capabilities and evidence criteria. Its
conclusion is a feasibility verdict.
_Avoid_: Operation, when referring to the overall experiment.

**Operation**
One owner-authorized resource lifecycle with a stable identity, fixed target
and execution window. Multiple deliveries and attempts may belong to one operation.
_Avoid_: Run, when the word could mean one execution or delivery.

**Owner authorization**
The owner's approval for one operation, binding its target, credential identity,
execution window, policy and reviewed evidence.

**Execution window**
The fixed period in which the operation may perform authorized cloud work.

**Schedule delivery**
One occurrence of a scheduled trigger offered to the executor for processing.

**Execution claim**
Temporary authority for one executor to advance an operation's durable state.
A stale claim has no authority to advance that state.

**Action attempt**
One bounded try at a named lifecycle action. Request reservations belong to an
attempt.

**Request reservation**
A charge against an operation's applicable budget that precedes a single
provider dispatch. An uncertain dispatch keeps its charge.

**Cleanup reserve**
The portion of an operation's request budget reserved for teardown and
reconciliation. Other operation work cannot spend it.

## Ownership and recovery

**Ownership evidence**
The recorded intent and matching provider observations that identify a resource
as belonging to the operation.

**Unresolved mutation**
A provider change for which the result has not been established. It prevents
further mutating dispatches under the operation until reconciliation.

**Reconciliation**
The work of resolving uncertainty by comparing retained intent and dispatch
records with admissible evidence of what happened.

**Resource teardown**
Verified removal of the operation's owned bucket and object.

**Owner closeout**
The owner's administrative work to remove schedules, deployment secrets,
credentials and dedicated identity resources. Its progress is tracked separately
from resource teardown.

## Outcomes and evidence

**Operation outcome**
The recorded lifecycle status of one operation: `active`, `needs-reconciliation`,
`succeeded` or `failed`. Expiry ends execution authority and can leave the outcome unresolved.

**Feasibility verdict**
The conclusion the trial evidence supports across the agreed capability and
allowance criteria. A successful operation can coexist with a partial verdict.

**Operation history**
A read-only view of the latest recorded operation state, including retained
expired or terminal operations.

**Needs attention**
A follow-up indicator in operation history. It flags an unresolved request or
mutation, an outcome of `needs-reconciliation`, or an expired execution window
with an outcome still recorded as `active`.

**Dated evidence**
An observation or report preserved with its observation time or cutoff. It
records what was established at that point.
