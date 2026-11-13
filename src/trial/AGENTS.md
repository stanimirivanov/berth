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
