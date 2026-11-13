# Private trial admission — issue #10

`makeTrialApi` exposes a Fetch-compatible private API for a single configured OCI
trial. It does not dispatch Alchemy, upload objects, deploy Functions or start a
scheduler. Submission calls the real atomic `makeLedger(...).start` contract;
workers must consume that saved intent and retain all existing ownership/budget gates.

## Server configuration

- Supply only compartment, namespace, home region, monitoring request limit and
  Neon invocation limit. Unsupported configuration fields fail construction.
- Load a private 32–128 character URL-safe bearer token and independent preview
  signing key from server secrets, never HTTP bodies, source files or logs.
- Supply `headroom()` with current owner evidence. `checkedAt` is epoch milliseconds
  and must be no older than 24 hours, never in the future. Accepted account types
  are `always-free` or `free-trial`, with the configured home region and Neon Free
  attested. Paid/unknown status is deliberately unsupported in this slice.
- Remaining aggregate allowance must cover at least 10 MiB storage, 200 Object
  Storage requests, 1 MiB transfer, and the configured Monitoring/Neon request
  budgets. `measuredComputeSeconds` is the positive measured **whole-window** Neon
  compute estimate; `neonComputeSeconds` is remaining allowance and must cover it.
  It is not an arbitrary per-invocation estimate. The owner must refresh evidence
  when account use changes; this API cannot independently verify billing totals.
- Supply `verifyCredentials()` as a bounded **read-only** check of the restricted
  runtime identity against the configured namespace/compartment/home region.
  False or thrown checks never permit creation. This callback is not a credential
  validator implementation; wire the reviewed OCI read-only checks at composition.
- Supply the restricted ledger connection with autocommit and bounded timeouts.
  Do not install migrations or pass owner credentials to the handler.
- Supply `admitCleanup(operation)` as a durable, fenced, idempotent admission port
  which accepts only an existing owned operation and queues its fixed cleanup.
  It must not permit arbitrary targets/actions. It is never a direct delete-by-name
  API. Concrete cleanup-worker/queue wiring remains later work.

The API itself has no SDK imports, filesystem access, secret-reading code or logs.
Use TLS, request/deadline limits and redacted access logs at the hosting boundary;
never log bearer tokens, signed previews, request bodies or raw port exceptions.
No hosted endpoint is deployed by this PR. The older twenty-minute runtime probe
configuration remains isolated qualification tooling, not the trial deployment.

## Private API-client flow

Every route is POST with `Authorization: Bearer <private token>` and exactly
`Content-Type: application/json`. JSON bodies are bounded to 2 KiB; query strings,
extra fields, arbitrary settings, targets and actions are rejected. Responses have
`Cache-Control: no-store`. There is no browser session, Angular UI or CORS contract.

1. POST `/preview` with `{}`. Authentication precedes parsing and port access.
   Current evidence and read-only credential checks must pass. The response includes
   a signed `preview`, its five-minute expiry and the exact bucket/object settings,
   deterministic object digest, server target and request budgets. It always shows
   `coverage: "partial-owner-attested"` and `hardSpendingCap: false`.
   Bucket ownership markers are explicitly shown as ledger-generated; their random
   value is allocated only when the ledger records submission.
2. Inspect the proposal. POST `/submit` with only `{"preview":"<returned value>"}`.
   HMAC verification binds the operation ID, fixed server configuration and issue
   time. Configuration changes, modified previews and expired previews fail.
   Evidence and credentials are rechecked, including freshness/expiry after async
   checks. The server atomically persists that exact previewed intent via the ledger.
3. Retain the returned operation and status. Identical signed previews reuse the
   same durable operation, including across independent handler instances; a second
   active operation is blocked by the SQL uniqueness/locking contract. A new preview
   is a different operation, so do not generate one to recover an uncertain submit.
   Preview itself writes neither SQL nor cloud state: the signed proposal becomes
   persisted intent only on accepted submission.
4. Use the returned `startedAt`, `runtimeExpiresAt` and `deploymentExpiresAt` when
   assembling the worker deployment. The latter two are identical projections of
   the ledger expiry, exactly four hours after its start. Do not recalculate expiry
   from retry/deployment time. Workers must enforce the stored window; this admission
   handler does not execute resources or extend a finished operation's lifetime.
5. POST `/cleanup` with only `{"operation":"<saved UUID>"}`. Authentication and
   operation validation remain mandatory. Creation headroom and credential checks
   are deliberately skipped, so stale evidence or expiry cannot prevent admitting
   owned cleanup. Actual cleanup still needs provider authorization, saved ownership,
   fencing and protected reservations. Admission is not successful cloud teardown.

## Failures and uncertainty

| Status | Meaning/action |
| --- | --- |
| 400 | Invalid body, altered/expired preview or unsupported input. No ledger start occurs. |
| 401 | Invalid bearer token; no port access. |
| 403 | Read-only credential check did not verify creation eligibility. |
| 404 | Unsupported method, path or query. |
| 409 | Missing/stale/insufficient evidence or unverified Free eligibility; creation blocked. |
| 503 | Backend rejection or uncertain outcome. A validated operation ID is included when available; reconcile that stable ID. Never infer no commit or issue a new trial automatically. |
| 202 | Ledger submission or cleanup admission acknowledged; not execution/teardown success. |

An expired preview cannot submit again; use its saved operation to reconcile or
request cleanup. A lost ledger response may already have committed. While the
preview is valid, matching resubmission remains atomic/idempotent. No error includes
provider/database bodies, credentials or caller-supplied arbitrary strings.

## Verification

```bash
pnpm build
node --test dist/tests/preflight.test.js dist/tests/trial-api.test.js
pnpm check:fast
pnpm check
# Fresh loopback PostgreSQL, prepared with test:setup-db:
BERTH_TEST_POSTGRES_PORT=your_local_port pnpm run test:ledger-db
```

Tests cover auth, fixed proposal/provider agreement, input injection, evidence
boundaries, preview tampering/expiry during credential verification, output redaction,
uncertain commits and cleanup admission without headroom. The real PostgreSQL suite
submits one preview concurrently from two API instances, proves zero preview rows,
one persisted matching intent and identical stored expiry; another active trial is
rejected. These are local contract tests, not live identity, billing or hosted proof.

Verification on 2026-11-13: `pnpm check` passed (104 application tests, 20 harness
checks, strict types/lint, bundle and secret scans). A fresh loopback PostgreSQL
instance passed bootstrap and all five ledger integration tests, including concurrent
API submission; the disposable container was removed. Inverting signature validation
caused four failures; restored code passed. No cloud credentials or mutations were
used. The unchanged dependency audit retains seven moderate and one low findings,
with no high/critical findings.
