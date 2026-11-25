# Independent owner cleanup — issue #70

**Reference for a separately authorized future operation, not instructions to run
another trial now.** The November 15 lifecycle remains failed / partial-no-go;
its resources and dedicated IAM identity are already removed. Do not reuse that
operation, consumed exception, revoked key or deleted compartment.

## When this procedure applies

- Neon Functions is unavailable, but Neon SQL and the trial OCI credential still
  work, the original four-hour window is open, and request capacity remains.
- The owner uses the existing `executeLive`/`runExecutor` implementation locally.
  No Functions endpoint, new executor, budget reset, migration, preparation or
  creation authorization is involved. This emergency fallback requires the owner
  online; it does not prove autonomous hosted cleanup.
- Owner recovery must have been qualified before the future operation was approved.
  If SQL, ownership evidence, usable credentials or capacity are missing, stop and
  preserve leftovers. There is no delete-by-name or expired-window fallback here.

Use the exact deployed commit, pinned Node/pnpm versions, local `psql` and the
existing Neon/OCI CLIs. Do not pull new code
mid-recovery. These commands were syntax-checked against the pinned Neon CLI and
installed OCI CLI help; this issue executed no account commands or cloud writes.

## 1. Identify the existing operation and stop further scheduled delivery

Set these from the saved, separately authorized operation's private records:

```bash
cd /home/izanagi/sources/infra-as-code/berth
umask 077
BERTH_PRIVATE_DIR="$HOME/.config/berth-trial"
export BERTH_OWNER_ENV_FILE="$BERTH_PRIVATE_DIR/live-env.json"
export BERTH_OPERATION='YOUR_EXISTING_OPERATION_UUID'
export BERTH_PROJECT_ID='YOUR_EXISTING_PROJECT_ID'
export BERTH_BRANCH_ID='YOUR_EXISTING_BRANCH_ID'
export BERTH_TRIGGER_ID='YOUR_SAVED_TRIGGER_ID'
export BERTH_FUNCTION_SLUG='YOUR_SAVED_FUNCTION_SLUG'
export PGSERVICEFILE="$BERTH_PRIVATE_DIR/pg_service.conf"
BERTH_RECOVERY_RUN=$(mktemp -d "$BERTH_PRIVATE_DIR/owner-recovery.XXXXXX")
export BERTH_RECOVERY_RUN
```

- `live-env.json` must be the saved exact deployment environment, a regular owner-only
  file outside Git (mode 600, at most 16 KiB). Use absolute paths, not literal `~`.
  It contains the restricted `berth_runtime` connection and trial signing key, never
  owner SQL credentials or the Neon management key. The validator checks both
  database URLs, credential identities and the fixed operation/window.
- `pg_service.conf` supplies the existing `berth-owner` service from the setup guide;
  keep it mode 600. This owner connection is for evidence reads, not runtime writes.
- Do not enable shell tracing or paste any private file contents into chat. Do not
  recreate a missing file from memory or substitute a different account/operation.

Using the existing private management token, disable only the saved trigger:

```bash
export NEON_API_KEY="$(cat "$BERTH_PRIVATE_DIR/neon-api-key")"
pnpm exec neon triggers disable "$BERTH_TRIGGER_ID" \
  --project-id "$BERTH_PROJECT_ID" --branch "$BERTH_BRANCH_ID" \
  > "$BERTH_RECOVERY_RUN/disable-trigger.txt" 2>&1
unset NEON_API_KEY
```

A CLI timeout or rejection is uncertain; retain the result and reconcile before
repeating a mutation. Disabling a trigger does not cancel an already accepted OCI
request or erase a lease. The executor's existing fencing and unresolved-intent
checks still apply. If the management API is unavailable, document that fact; do
not keep invoking the failed Functions endpoint.

## 2. Save a read-only SQL snapshot before every local action

```bash
psql service=berth-owner -X -tA -v ON_ERROR_STOP=1 \
  -v operation="$BERTH_OPERATION" <<'SQL' > "$BERTH_RECOVERY_RUN/before.json"
SELECT jsonb_build_object(
  'report', berth_executor.report(:'operation'::uuid),
  'requests', (SELECT coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb)
    FROM berth_ledger.requests r WHERE operation=:'operation'::uuid),
  'attempts', (SELECT coalesce(jsonb_agg(to_jsonb(a)), '[]'::jsonb)
    FROM berth_ledger.attempts a WHERE operation=:'operation'::uuid));
SQL
```

Review privately:

- Match operation, compartment, namespace, region, bucket, object, ownership marker,
  persisted revisions, receipt/digest and original start/expiry to the saved intent.
- Check `cleanup_used <= 40`, `normal_used <= 160`, Neon units and unresolved requests.
  An unresolved mutation remains spent; absent resources alone cannot clear a
  possibly late create/upload. Do not edit outcomes, counters, generations or expiry.
- If already terminal with resolved attempts and authenticated absence evidence,
  skip cloud work and proceed to administrative shutdown. A terminal label alone
  is not proof of absence. If expired, exhausted, inconsistent or unreadable, use
  the stop table below. Do not run another preparation or reset the #55 singleton.
- Preserve each snapshot under a new filename before the next step; do not overwrite
  evidence of an uncertain outcome. SQL reads can consume Postgres Free usage.

## 3. Queue cleanup once, then execute one local cleanup step

Build locally (`pnpm build`). Run the following block with
`BERTH_RECOVERY_ACTION=queue` once. After reviewing its private result and another
SQL snapshot, run it with `BERTH_RECOVERY_ACTION=step`. Change the result filename
for each invocation. Do not wrap this in a loop or automatically retry errors.

```bash
export BERTH_RECOVERY_ACTION=queue  # use step only after cleanup is durably queued
node --input-type=module <<'JS' > "$BERTH_RECOVERY_RUN/queue-result.txt" 2>&1
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { readPrivateText } from './dist/scripts/oci-files.js';
import { assertRuntimePrivileges } from './dist/src/storage/postgres/runtime-access.js';
import { liveEnvironment } from './dist/src/trial/live-environment.js';
import { executeLive } from './dist/src/trial/live-runtime.js';
try {
  const e = liveEnvironment(JSON.parse(await readPrivateText(process.env.BERTH_OWNER_ENV_FILE)));
  if (e.operation !== process.env.BERTH_OPERATION) throw Error('Mismatch');
  const action = process.env.BERTH_RECOVERY_ACTION;
  if (!['queue', 'step'].includes(action)) throw Error('Unsupported action');
  if (action === 'step') {
    const db = new Client({ connectionString: e.connection, connectionTimeoutMillis: 5000,
      statement_timeout: 5000, query_timeout: 6000 });
    try {
      await db.connect();
      await assertRuntimePrivileges(db);
      const r = (await db.query('SELECT berth_executor.report($1) AS value', [e.operation])).rows[0].value;
      if (!r.cleanup_requested) throw Error('Cleanup not queued');
    } finally { await db.end(); }
  }
  const result = action === 'queue'
    ? await executeLive(e, 'cleanup')
    : await executeLive(e, 'scheduled', `owner-recovery-${randomUUID()}`);
  console.log(JSON.stringify(result));
} catch {
  console.error('Owner recovery stopped; preserve evidence and reconcile. No automatic retry.');
  process.exitCode = 1;
}
JS
```

`scheduled` here is a local library action, not a request to Neon Functions. The
step refuses to run unless SQL already records cleanup. The same executor checks
its target/window again, reserves requests before sending, conditionally deletes
only owned revisions and reconciles uncertain writes. `queue` acknowledges intent,
not deletion; its single HTTP-control allowance cannot be spent repeatedly. A busy
lease, needs-reconciliation or expired response is not success.

For a subsequent step, review a new SQL snapshot and remaining capacity first;
use a new private output filename and delivery identity. The existing three-attempt
limit, 40-request reserve, twelve protected invocation units and original expiry
remain authoritative. A lost DELETE response can be reconciled from fresh owned
bucket/object inventory; a possibly late PUT/create requires stronger completion
evidence and may remain unresolved. Never issue an unconditional delete instead.

## 4. Stop conditions and leftovers

| Observation | Required response |
| --- | --- |
| SQL/ownership evidence unavailable or inconsistent | Stop without OCI mutation; retain private journals and exact identities; report unknown evidence |
| Unknown contents, marker/revision mismatch or conditional rejection | Preserve resources; report unexpected contents and owned revisions for owner reconciliation |
| Unresolved create/upload or an executor still holding a lease | Retain spent reservation and uncertainty; no competing create/delete or assumed absence |
| Cleanup requests exhausted | Report remaining resources and all 40 spent requests; no refund, extra reserve or direct-CLI deletion |
| Four-hour window expired | No further executor cloud work; read SQL evidence and request a separate explicit owner reconciliation decision |
| SQL terminal result with zero unresolved requests/open attempts and authenticated resource absence | Record manual recovery separately from hosted teardown. Retain partial feasibility and proceed to shutdown. |
| Retained-bucket continuation terminal with no unresolved work, child fixture absent and original bucket still verified | Record scoped recovery for the child. Preserve the original bucket and its evidence. Use the original authorization or separate owner decision for any further action. |

Any after-expiry or over-budget resource action needs separate explicit owner
review of ownership, late completion, new scope and separately accounted requests.
That is not renewal of this trial or permission supplied by this guide.

## 5. Remove hosting and revoke the dedicated trial key

By original expiry + 15 minutes, remove only the saved trigger/function. Capture
results privately and verify inventories; do not claim historical zero usage from
an empty inventory. Existing in-flight calls remain subject to ledger/expiry guards.

```bash
export NEON_API_KEY="$(cat "$BERTH_PRIVATE_DIR/neon-api-key")"
pnpm exec neon triggers delete "$BERTH_TRIGGER_ID" --project-id "$BERTH_PROJECT_ID" --branch "$BERTH_BRANCH_ID" > "$BERTH_RECOVERY_RUN/delete-trigger.txt" 2>&1
pnpm exec neon functions delete "$BERTH_FUNCTION_SLUG" --project-id "$BERTH_PROJECT_ID" --branch "$BERTH_BRANCH_ID" > "$BERTH_RECOVERY_RUN/delete-function.txt" 2>&1
pnpm exec neon triggers list --project-id "$BERTH_PROJECT_ID" --branch "$BERTH_BRANCH_ID" > "$BERTH_RECOVERY_RUN/triggers.txt" 2>&1
pnpm exec neon functions list --project-id "$BERTH_PROJECT_ID" --branch "$BERTH_BRANCH_ID" > "$BERTH_RECOVERY_RUN/functions.txt" 2>&1
unset NEON_API_KEY
```

After owned resource absence and zero unresolved work are established, set
`BERTH_OCI_USER_OCID`, `BERTH_OCI_FINGERPRINT` and `BERTH_OCI_OWNER_PROFILE` from the
saved trial identity and existing administrator CLI configuration. Verify that
this is the **trial user's key**, not the administrator profile's signing key:

```bash
oci iam user api-key delete --user-id "$BERTH_OCI_USER_OCID" \
  --fingerprint "$BERTH_OCI_FINGERPRINT" --profile "$BERTH_OCI_OWNER_PROFILE" \
  --force > "$BERTH_RECOVERY_RUN/revoke-key.json" 2>&1
oci iam user api-key list --user-id "$BERTH_OCI_USER_OCID" \
  --profile "$BERTH_OCI_OWNER_PROFILE" > "$BERTH_RECOVERY_RUN/remaining-keys.json" 2>&1
```

Verify no continuation/matching key remains. If resources or writes are uncertain,
retain the recovery credential privately and escalate owner reconciliation rather
than declare closeout complete. Never replay an uncertain IAM deletion blindly.
Dedicated IAM cleanup follows the [bootstrap guide](../oci-bootstrap.md); do not
remove unrelated policies, users, groups, the Default domain or the owner's key.
Keep ledger/state, the consumed exception, immutable policy authorization and all
private journals. Revocation does not erase local key copies. Publish only redacted
results and capability-level verdicts, with remaining Functions allowance unknown.
