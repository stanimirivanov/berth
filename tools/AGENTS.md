# Harness tools and CI

Use Node ESM with checkJs and meaningful JSDoc. Keep inputs deterministic, diagnostics
bounded, and errors nonzero. Do not execute source code to inspect its structure.
Parser-only TypeScript 5.9.3 is isolated as typescript-ast because the pinned native
TypeScript 7 compiler lacks that AST API; never substitute it for the build compiler.

Preserve passing and negative controls for ownership, docs, floor, workflow and scan
checks. Do not print source/secret contents or raw scanner reports. Static analysis
is not a sandbox, test-semantics proof or cloud-permission audit; document limitations.

Use `pnpm check:fast` in the opt-in hook and `pnpm check` in read-only CI. Keep pinned
Node/pnpm/scanner versions consistent with workflow fixtures. Preserve full-history
checkout, disabled persisted Git credentials and trusted-base floor execution. No
pull_request_target, cloud credentials, deployment, privileged publication or automatic
merge belongs in this verification workflow. Branch rules require owner configuration.
