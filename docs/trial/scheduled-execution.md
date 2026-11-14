# Bounded scheduled execution

Issue #11 connects the private admission API, operation ledger, narrow Alchemy
bucket provider and fixed object probe. The deployed qualification entry point is
**synthetic only**. Real OCI mutations remain gated by #13/#14.

## Owners and installation

- `executor-api.ts`: compose the existing authenticated preview/submit API with the
  ledger and a durable cleanup-request flag. Cleanup never grants ownership.
- `scheduled.ts`: validate the Neon gateway-attested invocation header and bounded
  schedule envelope; hash the delivery ID. Public clients cannot authenticate by
  supplying the header themselves. Requalify this gateway behavior if hosting changes.
- `executor.ts`: claim, reconcile, reserve, dispatch and checkpoint one phase.
- `executor-resources.ts`: real Alchemy plan/apply/destroy using ledger-fenced SQL
  state, one stack/stage/bucket. This is a separate closed bucket vocabulary; the
  earlier synthetic state adapter remains unchanged.
- `executor-store.ts` and `migrations/002_executor.sql`: durable delivery dedup,
  phase/receipt checkpoints and the same immutable owner/generation as the ledger.
- `executor-hosted.ts`: restricted connections and synthetic proof composition.
  `executor-synthetic.ts` emulates OCI in a separate durable SQL field; it cannot
  target a real compartment and has no OCI network transport.

On a dedicated database, the owner installs `migrations/001_trial.sql` once, then
`migrations/002_executor.sql` once. If #7's ledger already exists, install only 002.
Do not rerun either migration to recover an uncertain commit; inspect the schemas
first. Runtime code never migrates. Migration 002 extends ledger settlement with
`read-only-interruption` (only rejected nonmutations) and `not-dispatched` (only
rejected calls of the same generation). Neither refunds reservations.

The runtime role has only the approved function grants, with no executor table
access. Both injected database URLs must use `berth_runtime`. Owner URLs, OCI
credentials and enabled ambient AWS/AI credentials are rejected by the proof root.
Explicitly override `PGPASSWORD` with `disabled-for-berth-probe`. The runtime
checks the exact credential variable, not similarly prefixed metadata names. A
password is otherwise accepted only if it matches the password in both validated
restricted-role URLs; a different ambient password remains rejected. Environment
diagnostics disclose only a fixed category, never values.

The proof deployment allowlist is:

| Variable | Required value |
| --- | --- |
| `DATABASE_URL`, `DATABASE_URL_UNPOOLED` | Existing private restricted-role connections, never owner connections |
| `PGPASSWORD`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `NEON_AI_GATEWAY_TOKEN` | Literal `disabled-for-berth-probe` |
| `BERTH_TRIAL_TOKEN` | Private 32–128 character base64url token for the evidence route |
| `BERTH_EXECUTOR_MODE` | Literal `synthetic` |
| `BERTH_EXECUTOR_OPERATION` | Operation UUID returned by API submission |
| `BERTH_EXECUTOR_STARTED_AT`, `BERTH_EXECUTOR_EXPIRES_AT` | Unix milliseconds from that same ledger intent, exactly four hours apart |
| `BERTH_BUILD_DIGEST` | SHA-256 of the official Neon ZIP |

Deploy with Node.js 24. Verify missing-token evidence requests and forged schedule
headers return 401 before creating a trigger. The schedule calls POST `/scheduled`;
its body and invocation ID come from Neon, never from a browser. On completion,
disable and confirm the trigger, delete it and the proof functions, inspect terminal
SQL evidence, then dispose of the proof schemas only after all requests are resolved
and both synthetic resources and engine state are empty.

## Delivery and bounds

| Bound | Enforcement |
| --- | --- |
| Proposed cadence | Disabled `executorSchedule` in `neon.ts`, every 15 minutes |
| Creation cutoff | 30 minutes after the ledger start; checked before and after SQL renewal and immediately before signed transport dispatch |
| Cleanup start | On success, failure or cancellation; no later than hour 3 |
| Expiry | Hour 4, checked before connecting; SQL fence and transport also enforce deadlines |
| Invocation | At most 50 seconds of provider work, within a 60-second lease |
| Transport | Single send, no SDK retries, five-second request/body deadline, shared abort signal |
| Delivery admission | At most 4 KiB, 20-minute age, no future deliveries, durable SHA-256 dedup; at most 64 distinct claims |
| Requests | Existing ledger budgets: 160 normal and 40 protected cleanup; no refunds |

The 15-minute cadence leaves substantial room beyond a 50-second invocation and
five-minute delivery allowance. The final hour provides four nominal cleanup ticks;
provider scheduling is not an SLA and repeated failures can still require owner
reconciliation. An accelerated one-minute proof is separate from the production
cadence and does not establish a four-hour soak result.

The real transport factory `boundedObjectSdk` requires the restricted signer,
execution signal, and the session's ledger-derived `creationDeadline` in its fifth
argument (writes fail closed if omitted). The SDK factory must honor that signal.
No cloud request may bypass the metered dispatcher. Signer construction/deployment
with restricted OCI credentials remains behind the live trial gate.

## Recovery and safety

1. A new delivery atomically claims the operation. Duplicates and live competing
   leases do no provider work. State writes retain the captured generation.
2. Interrupted reads can be retired as rejected; uncertain mutations stay pending
   across lease expiry. There are at most three attempts per action, and open read
   attempts are reused across invocations instead of consuming one per SDK call.
3. Lost bucket creates require a positively observed matching identity and marker.
   Absent observations cannot settle a possibly late create or upload.
4. Lost uploads are verified and conditionally removed using the protected reserve.
   Cleanup validates ownership, configuration, revisions and content; it never
   adopts a name, force-deletes, or overwrites an object.
5. Terminal completion requires all requests resolved, successful conditional
   teardown and empty engine state. Late/ambiguous outcomes remain
   `needs-reconciliation`; expiry does not invent success.

A saved cleanup receipt pins a conditional GET directly; a pending upload without
a receipt still needs HEAD. Full ownership/configuration inspection precedes DELETE;
post-delete object/version/upload inventories prove absence, and bucket teardown
independently rechecks bucket ownership. The first bucket check is deferred until after the read-only object inventory and
checksum; the full fresh check still precedes conditional deletion. Both one
interrupted cleanup GET and a pre-delete interruption followed by resumed
object/bucket teardown fit within 40 protected calls. Repeated outages can exhaust
that reserve and require owner reconciliation.

The cleanup API sets a durable flag even when creation headroom is unknown. It
cannot interrupt an already dispatched cloud request; the next admitted phase
performs owned cleanup. Exhausted budgets, foreign resources or repeated transport
failures stop safely with durable evidence for the owner.

## Verification

```bash
pnpm check
pnpm build:executor
# Fresh disposable loopback Postgres, prepared by test:setup-db:
BERTH_TEST_POSTGRES_PORT=your_local_port pnpm test:executor-db
```

CI builds the official Neon bundle and runs the SQL integration suite. The suite
covers actual Alchemy lifecycle calls, persisted synthetic service state, duplicate
and overlapping deliveries, stale writers, late creates, lost uploads, read
interruption, cancellation and protected cleanup. Unit checks cover boundary
clocks, malformed schedule envelopes, restricted credentials and delayed signing.

See [scheduled evidence](scheduled-evidence.md) for the dated hosted result and
its limits. No build or test command enables a schedule or deploys resources.

With issue #12's Monitoring transport configured, successful upload enters `observe`
instead of immediate cleanup. Owner migration 003 enables hourly due checks and
retained warning history. Cancellation/failure/hour-three cleanup takes precedence;
missing metrics never extend the window. See [usage observation](usage-observation.md).
The dated #11 three-tick proof records the earlier synthetic configuration.
