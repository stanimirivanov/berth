# Hosted trial boundary

`index.ts` is the composition root: runtime environment, restricted DB connection,
actual Alchemy call and local OCI signing. `runtime-probe.ts` owns HTTP admission,
expiry, bounded input and instance-local receipt observations; it receives work by
injection and must not import SDKs or the engine. `synthetic-lifecycle.ts` owns its
isolated Alchemy state/provider. `deployment.ts` assembles an environment allowlist
for local deployment tooling; it reads no files and is not imported by the handler.

The runtime import allowlists in tools/harness.mjs enforce these owners. Register
new modules and edges explicitly with positive/negative fixtures. Never import
administrator scripts, private-file readers, shell tools or tests into hosted code.
Preserve the Neon gateway prerequisite for scheduler attestation. Receipt maps are
not durable deduplication; #5 owns the durable-backend proof.

Document exported declarations, types, methods and substantial named helpers using
[the comment standard](../../docs/comment-quality.md). Explain trust, state lifetime,
bounds and safe failures; never put credentials in comments, errors or evidence.
Run `pnpm run test:runtime-probe` for this slice, followed by canonical verification.

`state-probe.ts` owns the ephemeral Cloudflare qualification handler and native
Alchemy HTTP StateService adapter. Its fixed synthetic routes admit no caller
payloads, administrator credentials or local module imports. It has no production
lease/fencing contract: see docs/trial/cloudflare-state-evidence.md before reuse.

`fenced-state.ts` owns the narrow synthetic Postgres StateService. It receives a
parameterized SQL port and immutable execution claim; it imports only Alchemy and
Effect. Owner bootstrap is `sql/fenced-state.sql`; never run it from hosted code.
See docs/trial/fenced-postgres.md for limits, uncertainty and ownership recovery.

The issue #6 checkpoint adds a separate composition root `checkpoint-index.ts`.
`checkpoint-handler.ts` owns fixed-route admission, `checkpoint-run.ts` the two-step
qualification and `fenced-lifecycle.ts` its real synthetic Alchemy lifecycle. Only
that orchestrator may reach the adapter/lifecycle; the handler has no DB/engine
imports. SQL proof receipts preserve unfinished intents for inspection; they are
not the later OCI workflow implementation. See docs/trial/feasibility-decision.md.

`ledger.ts` owns only the parameterized operation-ledger interface; it has no package
or local imports. `migrations/001_trial.sql` owns atomic intent, lease, attempt and
budget rules under the separate owner role. Provider dispatch/settlement wiring is
later work; preserve unresolved intents independently of lease expiry. See
`docs/trial/operation-ledger.md` before adding a consumer.

`api.ts` owns fixed private admission routes, bounded bodies and signed previews;
`preflight.ts` owns pure evidence/configuration checks and the common four-hour
window projection. The handler may import only preflight and ledger types, never
SDKs or admin tooling. Preview has no persistence; accepted submission atomically
records the signed previewed intent. Cleanup admission skips creation headroom but
requires a durable owned-operation port. See docs/trial/admission-api.md.

`scheduled.ts` admits gateway-attested deliveries before any DB connection.
`executor.ts` owns bounded phases/reconciliation; `executor-store.ts` exposes only
owner-installed guarded SQL; `executor-resources.ts` adapts the real bucket provider
to Alchemy state under the ledger fence. `executor-api.ts` composes admission with
that ledger and durable cleanup flags. The synthetic hosted root and service are
qualification-only and must not gain OCI credentials. Read
`docs/trial/scheduled-execution.md` before changing deadlines, budgets or recovery;
run `test:executor-db` against a fresh disposable database and `build:executor`.

`warnings.ts` owns hourly admission, normalized observation persistence and the app
threshold contract. `providers/oci/usage.ts` owns only fixed Monitoring queries,
strict response validation and the single-send signed transport. The executor
reserves every Monitoring request separately, stops collection at cleanup, and
never waits for metrics before required teardown. Install owner migration 003 after
001/002; runtime cannot install it. Read `docs/trial/usage-observation.md`, and run
`test:usage-db` plus collector/API fixtures when changing these boundaries.

`live-index.ts` is the separate real OCI composition root; `live-hosted.ts` owns
fixed-route admission, `live-environment.ts` validates explicit trial credentials,
and `live-runtime.ts` owns restricted SQL plus real signed transports. Shared
`executor-security.ts` retains the synthetic root's connection/privilege checks.
The live root accepts only a pre-admitted operation and exact SQL target/window;
never add an admission bypass or import administrator/synthetic tooling here.
See docs/trial/live-executor.md. Build with `build:live-executor`; #47 owns live
admission/credential accounting and #14 owns operational acceptance.
