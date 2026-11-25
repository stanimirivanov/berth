# Authorize a provisioning continuation

Retry retains the original operation, outcome, expiry and accounting. Reading
status does no provider work. A Retry session can approve one exact proposal.
The existing fenced executor performs the approved work using its own
credentials, delivery gate, and ledger. History credentials grant read access
only. See [ADR 0009](../adr/0009-retry-provisioning-from-operation-detail.md).

## Owner action API

Use the existing [Retry sign-in and reconciliation routes](retry-reconciliation.md).
After starting reconciliation, read its result and then read the continuation
state. Endpoints take no query parameters or request body.

| Method and path | Result |
| --- | --- |
| `GET /api/retry/operations/:operation/continuation` | The current stop, proposal, original authority, or retained continuation. Returns 404 for an unknown operation. |
| `POST /api/retry/operations/:operation/proposals/:proposal/approve` | The retained authorization and progress for that exact proposal. Returns 409 if the proposal has expired, been replaced, or no longer qualifies. |

Both routes require a live Retry session. The status payload has the original
`operation` and one of the following shapes:

- `checking-provider` or `needs-attention` may report a fixed `reason` and
  `ownerProcedure`. **Preparation required** means no qualified proposal has
  been staged. A failed qualification reports `allowance-evidence-unqualified`,
  `credential-evidence-unqualified`, or `cleanup-evidence-unqualified` so the owner
  can revisit that part of the checklist. The API returns a reason code and
  owner procedure. The preparation inputs remain private. Other reasons cover
  expiry, withdrawal, an occupied slot, changed preparation and unsafe evidence.
- `continuing-provisioning` with `scope: original-window` shows the original
  `creationCutoff` and `expiresAt`. Existing deliveries use the original
  admission, cutoff and normal allowance. Retry creates no new authority and
  does not manufacture a scheduled delivery. Exhausted capacity, unresolved
  writes or a transition to cleanup make the action unavailable.
- `waiting-for-approval` contains the proposal ID, exact compartment,
  namespace, region and bucket, an instance ID when reusing the bucket, the
  scoped steps, dates, reviewed evidence
  reference and limits. The action owns 160 normal and 40 cleanup-only OCI
  requests, 20 Monitoring calls and 64 application units, including 12
  cleanup units. Each action has at most three attempts.
- An approved continuation carries a distinct `continuation` ID,
  `scope: after-expiry`, its approval and window timestamps,
  and `progress: awaiting-activation | executing | completed | stopped`.
  A stopped continuation includes a reason and owner procedure. A replay of
  the same approval or a new status read recovers this ID and its latest
  progress. It never creates a second authorization.

Approval applies only to the ID the owner reviewed. Allow up to five minutes from
preparation, capped by the activation deadline. Keep the proposal visible only
while the exact evidence still qualifies. The proposal shows nonsecret target
and review information. Private tags, revisions, credential identity, raw
provider data and the evidence document stay server-side.

## Retry in the Review inbox

Open the operation's saved detail from the inbox or follow **Review operation**
on an Uncertain Infrastructure row. Under **Needs attention**, select **Retry
provisioning** and sign in with the separate Retry owner credential. Berth reads
retained Retry status first. The control stays available on the same detail
after the original attention flags clear. **Check provider** starts
reconciliation only when that read calls for a new check. **Approve proposal**
applies only to the target, steps, dates and limits shown in the panel.

After a reload, reconnect to History and sign in to Retry again. After a lost
action response, use **Check retry status**. It reads retained state instead
of submitting the action again. If a proposal changed or expired, review the
fresh status before deciding whether to approve. The original lifecycle
outcome and partial/no-go verdict remain visible separately.

Retry action credentials and state live only in the open panel. Closing it,
navigating away, expiry, or a Retry access denial clears them. History remains
accessible through its independent read credential. Disconnecting from History
or losing its access also clears the Retry panel.

For a separately approved Retry deployment, set the production Pages binding
`BERTH_RETRY_NEON_ORIGIN` to the HTTPS origin of the dedicated Retry Function.
Keep this distinct from the History and Inventory upstream origins. Use the
existing canonical `BERTH_HISTORY_SITE_ORIGIN` binding. Leave Retry unset for a
read-only release and leave preview bindings unset. Pages forwards the separate
Retry owner credential or short-lived session only to the fixed Retry routes.
The Neon Function verifies both credentials. Pages needs no additional secret
and forwards no cookie, History credential, body, or retry attempt. The static
production CSP keeps `connect-src 'self'`.

## Prepare a proposal

Install migration 012 after 001–011 as the dedicated database owner. Use the
existing [Retry runtime role](retry-reconciliation.md#installation-prerequisites)
and an independently authorized executor. The Retry runtime can approve a
qualified proposal. It cannot prepare, withdraw, admit, or dispatch it.

1. Reconcile the expired operation. If Berth checked during the original window,
   a new Retry POST after expiry can start one independently metered check.
   The earlier check remains recorded. Verified scoped absence permits a fresh
   bucket only if no earlier write can still succeed. A rejected create needs a
   definite provider response or a durable not-dispatched receipt. A verified,
   unchanged owned instance permits uploading the fixed fixture if no previous
   object write remains. The child may remove its own fixture and must preserve
   the original bucket. A collision, incomplete inventory, disputed ownership,
   unresolved write, or started cleanup stops the proposal. A matching bucket
   establishes ownership but does not clear an unresolved original CREATE.
   Use the
   [independent owner procedure](owner-recovery.md#4-stop-conditions-and-leftovers).
2. Gather current eligibility, allowance, IAM and cleanup evidence for the child
   using the strict [Free evidence policy](../../SPEC.md#revised-functions-evidence-policy--issue-68-2026-11-19).
   Require OCI Always Free and known OCI and Neon Postgres/shared-transfer
   headroom. The reviewed policy can accept unknown Functions allowance. A
   known shortfall blocks preparation. Set `functionsKnownInsufficient: true`
   when the provider reports a shortfall. Neither historical one-operation
   exception is reusable. Withhold or
   withdraw preparation if eligibility, evidence, clearance for the fixed
   scoped signing identity, or independent cleanup access changes.
3. From the dedicated owner connection call
   `berth_retry.prepare_continuation(original, proposal, starts_at, binding, evidence)`.
   Generate a fresh v4 UUID for `proposal`. It becomes the child operation ID on
   approval. Choose the exact start in the next hour or an immediate start from
   the preceding minute, with millisecond precision. Approval ends at the
   earlier of five minutes after preparation and five minutes after the
   planned start. Supply the [existing live binding and strict evidence](hosted-admission.md)
   with the original target, explicit credential identity, 20 Monitoring and
   64 application units, and the new operation and window in `functionsPolicy`.
   Keep the original absence observation within the 24-hour evidence horizon
   through the new creation cutoff. The call returns `prepared` or a
   qualification stop reason. Commit either result. A qualification stop
   withdraws the prior unapproved proposal in the same transaction and makes
   the reason available through the status endpoint. A successful replacement
   clears that stop and becomes the only approvable proposal. An expired or
   interrupted reconciliation cannot be treated as absence.
4. Approve the displayed proposal using the Retry session. Commit records and
   prepares exactly one child operation. Activation still requires the
   existing bound executor's credential checks and signed preview and submit
   before start plus five minutes. Use the approval's child ID and window in
   the independently authorized executor. Its preview must show the original
   bucket name from the approved target. A fresh qualification or later
   review can stop the operation before any mutation.

## Dispatch, withdrawal and recovery

The existing dispatcher checks the new window and admission. Before CREATE it
revalidates absence and uses the child's marker and operation tag on the exact
approved name. For a retained bucket it verifies the original tags, provider ID,
revision, configuration and object inventory before the create-only PUT. The
fixture uses the child's tags. SQL rechecks the original proof and journal,
prepared evidence, scope, reservations and lease at the mutation gates and
before handing CREATE or PUT to the signed transport. Each continuation has its
own checkpoint and allowances. The original keeps its counters, outcome and
cleanup reserve. Approval can release an expired, qualified source's exclusive
executor slot without rewriting its outcome.

If the allowance, scope or evidence changes, the dedicated database owner can
call `berth_retry.withdraw_continuation(original)`. This prevents later
dispatch confirmations. A request confirmed before withdrawal may still reach
OCI, including while signing or transport is in progress. Use the retained
journal to distinguish a reserved-but-unsent action from an uncertain send.
If the child missed its activation window, the dedicated owner can close it
with `berth_retry.close_unactivated(original)`. This releases the slot only
when activation and provider mutations never occurred. Approval remains recorded.

To stop or recover the child after any dispatch, use the
[independent owner procedure](owner-recovery.md) with the **child** ID and its
exact saved executor environment. This uses the child’s existing reserve even
when creation qualification or approval has been withdrawn. For a retained
bucket verify the child fixture is absent and the original instance remains.
The owner procedure for any original bucket removal stays separate. If the child's
window has expired or an earlier write remains unresolved, follow that
procedure's stop conditions and preserve the evidence. The historical
partial/no-go verdict and the read-only release decision remain separate.

## Verification

Run `pnpm check`, `pnpm build:retry`, and `pnpm build:live-executor`.
Run `pnpm test:retry-db` on disposable loopback PostgreSQL after
`pnpm test:setup-db`. Retry cases use a synthetic provider with no network
fallback. Build and fixture results do not authorize hosted preparation,
provisioning, or a live trial.
