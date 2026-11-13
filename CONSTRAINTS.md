# Berth quality contract

These controls apply to the existing trial. Proposed changes to their scope or
strength need explicit review in a dedicated issue/PR; never add a silent bypass.

| Control | Required result | Sensor |
| --- | --- | --- |
| Formatting and types | Zero diagnostics; strict application and checkJs harness projects | `pnpm lint`, `pnpm typecheck` |
| Trial/tool contracts | Attached prose JSDoc/TSDoc on public declarations, types, methods and named helpers of at least six lines | `pnpm harness` |
| Runtime ownership | Closed module/package imports; no hosted/admin coupling, CommonJS/dynamic loaders or runtime cycles | `pnpm harness` |
| Verification integrity | No suppression comments or disabled/focused tests; baseline literal test-name counts preserved | `pnpm harness`, `pnpm floor` |
| Existing commands | Original command retained; only additional namespaced check chains admitted | `pnpm floor` |
| Private indexed material | No credential paths, keys or private-prefixed components | `pnpm harness` |
| Secrets | Zero Gitleaks findings in worktree, index and locally available history; tool/report failures fail | `pnpm secrets` |
| Dependencies | No reported high/critical advisories; lower findings still reviewed | `pnpm security` |
| Behavior and packaging | All local suites and official Neon bundle build succeed | `pnpm test`, `pnpm build:runtime-probe` |
| SQL boundary | Fresh loopback database permission and drift tests pass | CI `pnpm test:setup-db` |

No coverage percentage is invented for unmeasured code. Legacy scripts need a
reviewed documentation backfill before widening the documentation gate. Those gaps
are explicit in HARNESS.md. Existing commands and tests are preserved; this contract
does not authorize weakening the approved SPEC.md resource/request/time budgets.

Exceptions must identify scope, reason, owner, removal issue and expiry. A prose
exception does not bypass a check: a deliberate policy revision and owner review
are required. External branch protection is necessary to make CI merge-blocking.
