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

Run the relevant existing setup/doctor tests; CI also runs the disposable loopback
PostgreSQL integration suite without any Neon or OCI secrets.

`history-server.ts` is the narrow loopback-only preview exception: it may compose
`src/application/history/api.ts` and `src/application/history/runtime.ts`, never the live executor or an OCI port.
It serves the built UI and private read API at one origin; no credential-file reads.
