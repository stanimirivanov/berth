# Local administrator and build commands

Scripts own private-file access, explicit CLI parameters, provider management calls,
redacted diagnostics, journals and operator reconciliation. They are not runtime
code. Imports may compose other scripts, neon.ts and the deployment environment
allowlist. Do not import hosted entrypoints or tests. Type-only admin/recovery
references are permitted; runtime import cycles are not.

Preserve existing fail-closed file ownership, permissions, request bounds and
intent-before-write behavior. Never add an automatic retry to uncertain mutations.
Keep credentials outside the checkout and command-line arguments. Cloud verification
requires the task's explicit scope; `pnpm check` must remain cloud-independent.

Apply the comment standard to new/changed contracts. Legacy script documentation
backfill is a recorded hardening step, not silently claimed as enforced today.
Run the relevant existing setup/doctor tests; CI also runs the disposable loopback
PostgreSQL integration suite without any Neon or OCI secrets.
