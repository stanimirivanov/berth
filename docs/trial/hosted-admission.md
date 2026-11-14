# Hosted admission and activation — issue #47

This runbook prepares **one** dedicated OCI trial. It does not authorize paid plans
or establish the live verdict in #14. Complete the current account, IAM and allowance
checks in [the setup guide](../oci-neon-setup.md) before activation. Use the pinned
Node/pnpm tools and a local PostgreSQL `psql` client. All timestamps below are UTC; SQL is the time authority.

## What changed

- Live `/preview` is cloud-read-only, **not persistence-free**. It records a Neon
  invocation and reserves each of two credential checks before sending them:
  GetNamespace and ListBuckets (`limit=1`, no pagination). Both spend the existing
  160 normal Object Storage allowance. No bucket/object is created by preview.
- The owner prepares one UUID, target, identity, evidence and future four-hour
  window. All previews use that UUID. A successful five-minute credential receipt
  is bound to the prepared identity/key/target; the signed preview also binds the
  window. Replays do not repeat the empty-compartment check after admission.
- Submit atomically opens the SQL creation gate. It is accepted only in the first
  five minutes of the window. Both attempt creation and dispatch reservation enforce
  that gate and reject cancellation. Both owner attestations must remain fresh
  through the entire 30-minute creation window, not merely at submission.
  Unprepared live operations cannot create.
- The already-enabled schedule performs the journey after submit, without the
  client computer. A delivery can execute bucket and object phases under one shared
  50-second deadline. Deterministic subdelivery IDs preserve replay protection.
- Each actual executor step is conservatively charged one Neon reservation (two
  for a paired initial delivery). Preview/submit and controls have separate durable
  HTTP receipts charged to the **same** Neon counter. At most six admission calls
  are accepted. Twelve Neon units are protected from ordinary calls: at most one
  can be spent on cleanup control, leaving at least eleven for execution. Ordinary
  HTTP receipts are capped at 52; only one cleanup-control receipt is accepted.
  Its charge and cancellation flag commit atomically. Repeated cleanup controls
  are rejected without another charge; a lost response cannot prevent queued cleanup.
  Failure, reconciliation state and creation/cleanup deadlines can also authorize
  protected execution before hour three. Spending it durably selects cleanup and
  blocks new creation.
- Live Neon budgets must be at least 40: at most 13 normal executor steps, six
  admission calls, six planned controls and twelve cleanup units require 37 units.
  Configure 64 only if current aggregate headroom covers 64. Extra control requests,
  duplicate deliveries and failed calls consume allowance; there are no refunds.
- A successful credential inspection attempt remains open for the executor to
  reuse, rather than consuming a fourth inspection attempt. Failed checks consume
  one of the existing three attempts. No automatic retry occurs.
- If no submit arrives by minute five, a schedule requests cleanup and reconciles
  spent read reservations before expiry. Cleanup never requires fresh creation
  evidence. Expired requests perform no database or OCI work.

These are application bounds, not provider hard spending caps. Rejected gateway
requests, expired calls and management/API activity may still consume provider
allowances without entering SQL. Keep separate owner usage evidence for those calls.
The runtime has no Neon management key and cannot delete its own trigger. If the
computer remains offline after expiry, scheduled invocations continue returning
`expired` until the owner disables the trigger. Plan allowance headroom for that
period; automatic OCI teardown does not imply automatic hosting/IAM removal.

## 1. Prepare private owner inputs

- In the repository shell set `BERTH_PRIVATE_DIR="$HOME/.config/berth-trial"` and
  `umask 077`. Keep shell tracing off. Do not paste secrets into command arguments.
- Set `BERTH_PROJECT_ID` and `BERTH_BRANCH_ID` to the existing dedicated Neon target.
- Create `$BERTH_PRIVATE_DIR/pg_service.conf` with mode 600, using the **direct owner
  connection** from Neon Console → project → **Connect**. Select database `neondb`
  and role `neondb_owner`; copy host/password privately:

  ```ini
  [berth-owner]
  host=YOUR_DIRECT_NEON_HOST
  port=5432
  dbname=neondb
  user=neondb_owner
  password=YOUR_OWNER_PASSWORD
  sslmode=verify-full
  ```

- Set `PGSERVICEFILE="$BERTH_PRIVATE_DIR/pg_service.conf"` and export it.
- Install migrations 001–003 only if this dedicated database has not already had
  them installed. Never rerun a fresh-only migration or delete existing trial state
  to make installation succeed. Then install the new migration:

  ```bash
  psql service=berth-owner -X -v ON_ERROR_STOP=1 -f migrations/004_admission.sql
  ```

- Create `$BERTH_PRIVATE_DIR/prepare-live.sql` (600). Replace every placeholder below.
  Use actual measured remaining allowances, not fixture values. `checkedAt` and
  `iamCheckedAt` are epoch milliseconds. Both must remain no older than 24 hours
  through the prepared start plus 30 minutes. `iamReviewed=true`
  means the owner actually reviewed all effective grants/group memberships for the
  named trial user; the runtime cannot audit IAM. The home region must match OCI.
  Choose a fresh version-4 UUID once (`node -e 'console.log(crypto.randomUUID())'`).

  ```sql
  \set ON_ERROR_STOP on
  SELECT berth_executor.prepare(
    'YOUR_OPERATION_UUID'::uuid,
    date_trunc('milliseconds',clock_timestamp()+interval '15 minutes'),
    '{"compartment":"YOUR_COMPARTMENT_OCID","namespace":"YOUR_NAMESPACE","region":"eu-frankfurt-1","monitoringLimit":20,"neonLimit":64,"tenancy":"YOUR_TENANCY_OCID","user":"YOUR_TRIAL_USER_OCID","fingerprint":"YOUR_TRIAL_KEY_FINGERPRINT"}'::jsonb,
    '{"checkedAt":YOUR_TIMESTAMP_MS,"iamCheckedAt":YOUR_TIMESTAMP_MS,"iamReviewed":true,"accountType":"always-free","homeRegion":"eu-frankfurt-1","storageBytes":YOUR_REMAINING_BYTES,"objectRequests":YOUR_REMAINING_REQUESTS,"transferBytes":YOUR_REMAINING_TRANSFER_BYTES,"monitoringRequests":YOUR_REMAINING_MONITORING_REQUESTS,"neonFree":true,"neonInvocations":YOUR_REMAINING_INVOCATIONS,"neonComputeSeconds":YOUR_REMAINING_COMPUTE_SECONDS,"measuredComputeSeconds":YOUR_MEASURED_WHOLE_WINDOW_COMPUTE_SECONDS}'::jsonb
  );
  ```

- Run once and retain the output privately:

  ```bash
  psql service=berth-owner -X -At -f "$BERTH_PRIVATE_DIR/prepare-live.sql" \
    > "$BERTH_PRIVATE_DIR/prepared-trial.json"
  ```

  A failure may have committed. Inspect the saved operation with
  `SELECT berth_executor.report('YOUR_OPERATION_UUID');` before taking further
  action. Never switch UUID, reset timestamps or rerun preparation to conceal an
  uncertain result. Preparation does not contact OCI.

## 2. Build and deploy before the prepared start

1. Run `pnpm run build:live-executor`; retain its digest with the trial evidence.
2. Create `$BERTH_PRIVATE_DIR/live-env.json` (600), a JSON object of **string** values
   containing exactly the environment inputs in [live-executor.md](live-executor.md).
   Add `BERTH_PREVIEW_KEY` (an independent 32–128 character URL-safe random secret),
   `BERTH_MONITORING_LIMIT` and `BERTH_NEON_LIMIT` matching preparation.
   Convert the saved SQL `started_at` / `expires_at` to epoch milliseconds for the
   two executor timestamps. Do not calculate a new expiry from deployment time.
3. Override **both** database URLs with `berth_runtime` credentials. Set `PGPASSWORD`,
   `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` and `NEON_AI_GATEWAY_TOKEN` to
   `disabled-for-berth-probe`; never put the Neon management token or owner DB
   credentials in this JSON. `OCI_PRIVATE_KEY` is the trial PEM contents, encoded
   as a JSON string with escaped newlines, not a local path or administrator key.
4. Create `$BERTH_PRIVATE_DIR/live-policy.ts` (600):

   ```typescript
   import { readFileSync } from "node:fs";
   import { liveFunction } from "/home/izanagi/sources/infra-as-code/berth/neon.ts";
   const env = JSON.parse(readFileSync("/home/izanagi/.config/berth-trial/live-env.json", "utf8"));
   const allowed = new Set([
     "DATABASE_URL", "DATABASE_URL_UNPOOLED", "PGPASSWORD", "AWS_ACCESS_KEY_ID",
     "AWS_SECRET_ACCESS_KEY", "NEON_AI_GATEWAY_TOKEN", "BERTH_EXECUTOR_MODE",
     "BERTH_EXECUTOR_OPERATION", "BERTH_EXECUTOR_STARTED_AT", "BERTH_EXECUTOR_EXPIRES_AT",
     "BERTH_TRIAL_TOKEN", "BERTH_PREVIEW_KEY", "BERTH_MONITORING_LIMIT", "BERTH_NEON_LIMIT",
     "OCI_TENANCY_OCID", "OCI_USER_OCID", "OCI_FINGERPRINT", "OCI_PRIVATE_KEY",
     "OCI_REGION", "OCI_COMPARTMENT_OCID", "OCI_NAMESPACE"
   ]);
   if (Object.entries(env).some(([name, value]) => !allowed.has(name) || typeof value !== "string"))
     throw Error("Unexpected deployment input");
   const { slug, runtime, ...definition } = liveFunction;
   export default { preview: { functions: { [slug]: {
     ...definition,
     source: "/home/izanagi/sources/infra-as-code/berth/src/trial/live-index.ts",
     env
   } } } };
   ```

5. Load the management token only into the local CLI environment and inspect the
   plan privately. The policy forwards only `live-env.json`, not ambient variables:

   ```bash
   export NEON_API_KEY="$(cat "$BERTH_PRIVATE_DIR/neon-api-key")"
   pnpm exec neon config plan --project-id "$BERTH_PROJECT_ID" --branch "$BERTH_BRANCH_ID" \
     --config "$BERTH_PRIVATE_DIR/live-policy.ts" > "$BERTH_PRIVATE_DIR/deploy-plan.txt"
   ```

   Review that only `berthlive46` is created/updated. Stop on unrelated service,
   branch, database, paid-plan or scale changes. Do not use `--yes` to bypass review.
6. Deploy the reviewed policy; prevent automatic owner-URL env-file pulls:

   ```bash
   pnpm exec neon deploy --project-id "$BERTH_PROJECT_ID" --branch "$BERTH_BRANCH_ID" \
     --config "$BERTH_PRIVATE_DIR/live-policy.ts" --no-env-pull \
     > "$BERTH_PRIVATE_DIR/deploy-result.txt"
   ```

   Record the function URL/deployment ID privately. Deployment failures may be
   uncertain; inspect the same function before retrying. If deployment cannot
   finish before the prepared start, do not extend the window; reconcile and stop.

## 3. Arm the schedule, preview and submit

- Create the trigger **disabled**, save the returned ID, then inspect it:

  ```bash
  pnpm exec neon triggers create --project-id "$BERTH_PROJECT_ID" --branch "$BERTH_BRANCH_ID" \
    --function-slug berthlive46 --name berth-live-trial --function-path /scheduled \
    --cron '*/15 * * * *' --enabled false > "$BERTH_PRIVATE_DIR/live-trigger.txt"
  ```

- Set `BERTH_TRIGGER_ID` to that ID. Verify gateway trigger-header stripping using
  the existing synthetic proof evidence and current deployment settings; a manual
  bearer request to `/scheduled` must return 401 without work. If that prerequisite
  has changed or is unknown, stop. Do not test it by sending forged trigger headers
  to the armed live endpoint.
- Before the prepared start, enable only this trigger:

  ```bash
  pnpm exec neon triggers enable "$BERTH_TRIGGER_ID" \
    --project-id "$BERTH_PROJECT_ID" --branch "$BERTH_BRANCH_ID"
  ```

- At start, create a private curl config `$BERTH_PRIVATE_DIR/live-curl.conf` (600):
  `header = "Authorization: Bearer YOUR_TRIAL_TOKEN"` on one line and
  `header = "Content-Type: application/json"` on the next. Set `BERTH_LIVE_URL` to
  the function HTTPS origin, without a trailing slash.
- Within the first five minutes:

  ```bash
  curl --silent --show-error --fail-with-body --config "$BERTH_PRIVATE_DIR/live-curl.conf" \
    --request POST --data '{}' "$BERTH_LIVE_URL/preview" > "$BERTH_PRIVATE_DIR/preview.json"
  ```

  Review the exact one-bucket/one-object proposal and cap limitations. Save only
  `{"preview":"RETURNED_SIGNED_PREVIEW"}` in `$BERTH_PRIVATE_DIR/submit.json` (600).

  ```bash
  curl --silent --show-error --fail-with-body --config "$BERTH_PRIVATE_DIR/live-curl.conf" \
    --request POST --data-binary @"$BERTH_PRIVATE_DIR/submit.json" \
    "$BERTH_LIVE_URL/submit" > "$BERTH_PRIVATE_DIR/submission.json"
  ```

- A 202 confirms durable admission, not cloud success. A lost/503 response may have
  committed: inspect `/evidence` or retry the **same unexpired** preview once; do not
  generate a new UUID. Never automate retries. Six preview/submit invocations are
  the total admission cap. The computer can now go offline; the schedule owns
  creation, observation, conditional cleanup and recovery.
- The first useful trigger is expected within 15 minutes, with a planned five-minute
  delivery margin and at most 50 seconds shared work: under 21 minutes from start,
  leaving over nine minutes before creation cutoff. This is a readiness assumption
  to measure in #14, not a Neon delivery guarantee. Excess delay or work exceeding
  the shared deadline must fail safely and produce a partial verdict.

## 4. Evidence, one controlled interruption, and shutdown

- POST `/evidence`, `/usage` or `/cleanup` with the private curl config and **no body**
  (`--request POST`, omit `--data`). They refer only to the configured operation.
  A cleanup response only queues cleanup; it is not absence evidence.
- For #14's bounded interruption, wait for persisted phase `observe` and a verified
  upload receipt. Disable this trigger once, retain its ID/time, then re-enable the
  **same** trigger within 15 minutes and before hour two. Do not change UUID, SQL
  state, keys, counters or deployment clocks. Check that observation resumes and
  teardown happens by expiry. This proves a missed scheduled delivery; process-kill
  and unknown-write safety remain separately evidenced by local crash tests.
- Do not disable the trigger during required cleanup. If metrics are absent, retain
  the inconclusive status and let cleanup proceed. After terminal status, confirm
  authenticated OCI absence and no unresolved ledger requests before claiming pass.
- After terminal evidence (or at hour four if still unresolved), disable and delete
  this trigger, then delete the function to remove its deployed secrets:

  ```bash
  pnpm exec neon triggers disable "$BERTH_TRIGGER_ID" --project-id "$BERTH_PROJECT_ID" --branch "$BERTH_BRANCH_ID"
  pnpm exec neon triggers delete "$BERTH_TRIGGER_ID" --project-id "$BERTH_PROJECT_ID" --branch "$BERTH_BRANCH_ID"
  pnpm exec neon functions delete berthlive46 --project-id "$BERTH_PROJECT_ID" --branch "$BERTH_BRANCH_ID"
  unset NEON_API_KEY
  ```

- Preserve private journals, SQL evidence, keys and unresolved identities for owner
  reconciliation. Remove the trial API key registration in OCI only after absence
  is confirmed; unresolved resources require owner recovery, not a success claim.
  Follow [OCI bootstrap cleanup](../oci-bootstrap.md) for dedicated IAM resources.

CLI command names/options were checked against pinned Neon 9.4.0 `--help`. The
[Neon function guide](https://neon.com/blog/neon-functions-backend-logic-next-to-your-data)
and [scheduled trigger guide](https://neon.com/blog/your-neon-functions-can-now-run-on-a-schedule)
explain the hosting model; current Free allowances must still be checked in Console.
This issue performs local verification only; #14 must record actual deployment,
provider timing, quotas, metrics, interruption and absence evidence.
