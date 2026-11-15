# One-trial Neon Free Functions exception — issue #55

The owner explicitly accepted this exception on 2026-11-15. It permits one
four-hour experiment with unknown remaining Functions allowance. It does not
assert free allowance headroom, eliminate charge risk, or authorize a paid plan.
PR #50 remains draft until actual evidence is collected and reviewed. This change
installs no schema or hosted function and activates no schedule.

## Contract and limits

- Mode: `free-functions-one-trial`. Normal mode (absent or `verified`) still requires
  measured Functions evidence. Unknown modes and mixed exception/numeric Functions
  evidence fail closed.
- Exactly 64 application Neon units, including the existing 12 cleanup units;
  160 ordinary + 40 cleanup OCI requests; unchanged Monitoring limit. The four-hour
  expiry, minute-30 creation cutoff, hour-three cleanup and ownership checks remain.
- Forward scenario `64x60-plus36x60-v1`: 64 application units + 32 assumed overhead
  calls + four assumed administrative-tail calls, each 60 seconds: 6,000 capacity
  seconds and 100 invocations. This is **an estimate, not remaining quota or a hard
  retry bound**. The recorded client probe must be positive and at most 3,000 ms
  for the 20× planning margin. See [qualification](functions-headroom.md).
- Dated Free-plan, other-service usage and effective-IAM evidence is still required.
  `otherServicesEvidence` is a nonsecret identifier for the privately retained
  owner review, not a path, URL or credential. Retain the actual Neon database
  CU-hours/storage/transfer figures, period and capture time under that identifier.
  The code cannot authenticate owner attestations or measure missing provider data.
- Owner confirms exclusive project use, accepts unknown Functions consumption and
  partial verdict, and has a working administrative shutdown and owned-resource
  recovery route. All commitments are mandatory; no default acknowledgement.
- Administrative shutdown deadline is exactly persisted expiry + 15 minutes. This
  is an owner commitment, **not automatic provider shutdown**. Quota exhaustion can
  prevent hosted cleanup; retain keys and durable identities for manual recovery.

## Install before preparing the trial

1. Follow [hosted admission](hosted-admission.md#1-prepare-private-owner-inputs) to
   configure the private `berth-owner` psql service. Keep credentials outside Git.
2. Inspect which migrations are installed. Install 001–004 in order only if absent;
   do not rerun fresh-only migrations, drop schemas or erase trial history.
3. Install this migration once, as `neondb_owner`:

   ```bash
   psql service=berth-owner -X -v ON_ERROR_STOP=1 -f migrations/005_functions_exception.sql
   ```

4. Inspect the authorization slot before preparing anything:

   ```sql
   SELECT operation, started_at, expires_at FROM berth_executor.functions_exception;
   ```

   Zero rows means unused. One row means consumed: resume/reconcile that operation.
   Do not delete the row, change UUID/window/evidence, use the internal legacy
   functions, or recreate the schema/database to obtain another exception. A new
   experiment requires a new explicit owner-reviewed policy change. The database
   owner remains trusted; runtime privileges cannot reset or bypass this slot.

## Prepare once with actual evidence

Use the binding object from the existing runbook, with `neonLimit: 64`. Keep all
other limits and credentials unchanged. In the evidence object:

- Keep `checkedAt`, `iamCheckedAt`, `iamReviewed`, `accountType`, `homeRegion`,
  `storageBytes`, `objectRequests`, `transferBytes`, `monitoringRequests`, `neonFree`.
  Use actual reviewed values. Both timestamps must stay fresh through start + 30
  minutes; neither can be in the future. `checkedAt` also dates the plan and
  other-service review referenced below.
- **Omit** `neonInvocations`, `neonComputeSeconds`, `measuredComputeSeconds` entirely.
  Zero, null, synthetic figures and guessed remaining allowance are rejected.
- Build the exception binding from the same SQL start timestamp, avoiding clock
  rounding or independently calculated windows. Save this in the private preparation
  file from the existing runbook and replace all `YOUR_...` values before execution:

  ```sql
  \set ON_ERROR_STOP on
  WITH input AS (
    SELECT 'YOUR_OPERATION_UUID'::uuid AS operation,
      date_trunc('milliseconds',clock_timestamp()+interval '15 minutes') AS start,
      'YOUR_BINDING_JSON'::jsonb AS binding,
      'YOUR_EVIDENCE_JSON_WITHOUT_FUNCTIONS_NUMBERS'::jsonb AS evidence
  )
  SELECT berth_executor.prepare(operation,start,binding,
    evidence || jsonb_build_object(
      'functionsMode','free-functions-one-trial',
      'functionsException',jsonb_build_object(
        'operation',operation,
        'startedAt',extract(epoch FROM start)*1000,
        'expiresAt',extract(epoch FROM start+interval '4 hours')*1000,
        'shutdownBy',extract(epoch FROM start+interval '4 hours 15 minutes')*1000,
        'unknownAllowanceAccepted',true,
        'partialVerdictAccepted',true,
        'exclusiveProjectUse',true,
        'manualRecoveryReady',true,
        'otherServicesEvidence','YOUR_REVIEW_ID',
        'probeClientMs',2252,
        'scenario','64x60-plus36x60-v1'
      ))) FROM input;
  ```

  `2252` is the recorded qualification probe, not a new live measurement. If a new
  probe exceeds 3,000 ms, stop and reassess the scenario; do not edit its duration
  or expand budgets to make the gate pass. Replace each `true` only after confirming
  its statement. Missing/false commitments stop preparation.

Preparation and singleton consumption commit atomically. A rejected transaction
consumes nothing; a lost response is uncertain. Inspect the slot and report for
that UUID before deciding whether anything needs retrying. Successful preparation
consumes the authorization even if deployment fails, the schedule never starts,
the run is cancelled, or lifecycle cleanup succeeds. Do not prepare another run.

## Deploy, execute and stop

- Continue the existing [build/deploy and trigger steps](hosted-admission.md#2-build-and-deploy-before-the-prepared-start)
  with the returned window and same operation. No extra environment variable,
  privileged runtime credential or HTTP opt-in flag is introduced.
- New hosted code rejects exception admission when migration 005's durable
  qualification is absent. Runtime can neither prepare nor alter the exception.
- Review `/preview`: `feasibility.verdict` must be `partial`, `functionsAllowance`
  must be `unknown`, `hardSpendingCap` must be false, and the fixed forward scenario
  must be shown. `/submit` retains the same qualification. Do not submit on a
  missing or different qualification.
- Execute #14's bounded lifecycle, observation and interruption steps. Do not spend
  extra requests trying to obtain a nonexistent Functions usage counter.
- Arrange to be available at expiry. By expiry + 15 minutes, disable/delete the
  saved trigger and delete the function using the exact commands in
  [shutdown](hosted-admission.md#4-evidence-one-controlled-interruption-and-shutdown).
  Confirm inventories and retain times. Late shutdown breaches this exception;
  do not hide it or extend the window.
- If hosting quota blocks cleanup: stop repeated invocations, preserve the operation,
  ownership marker, resource names, revisions and unresolved intents, and retain
  the OCI key. Use the owner's OCI access to inspect those exact resources. Apply
  the existing conditional ownership/revision checks before deletion; unexpected
  contents, mismatched ownership or uncertain completion require reconciliation.
  Never infer absence from an authorization error or delete an unverified resource.
  Record leftovers and manual recovery; revoke the key only after authenticated
  absence is established. See [teardown contract](../../SPEC.md#acceptance-and-verification)
  and [administrator cleanup](../oci-bootstrap.md).

## Reporting and verification

SQL `berth_executor.report(operation)` retains `feasibility` from the immutable
slot. `/evidence` includes it alongside lifecycle `status`; `/usage` in this mode
returns `{usage, feasibility}`. `status: succeeded` means resource lifecycle success,
**not a feasibility pass**. The report remains partial after success, failure,
expiry and cleanup. Remaining Functions allowance stays unknown. Missing metrics
or other acceptance failures must also remain visible in #14's evidence.

Removal/closure owner: trial owner, tracked by #14. Authorization expires with its
one prepared four-hour window; administrative follow-up is due 15 minutes later.
Retain the consumed slot as audit evidence permanently; do not reset it on closure.

Local verification uses preflight/API tests and the disposable PostgreSQL admission
suite for concurrent preparation, immutable bindings, privilege denials, idempotent
admission and final partial evidence. These tests neither consume the real slot nor
prove live quota, provider timing, teardown or spending guarantees.
