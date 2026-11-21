# Berth verification reference

Start at [AGENTS.md](AGENTS.md) for workflow and scoped guides. This reference
explains the backend, Angular and CI verification gates.

```text
AGENTS.md                      agent skills and technical contracts
CONSTRAINTS.md                 written quality floor
HARNESS.md                     ownership and verification gates
src/trial/AGENTS.md            hosted runtime and synthetic state boundaries
scripts/AGENTS.md              administrator/private-file effects
tests/AGENTS.md                independent fixtures and evidence
tools/AGENTS.md               sensor authoring and CI trust
tools/harness.mjs             AST documentation/import/quality and private-path checks
tools/floor.mjs               baseline test/command retention
tools/secrets.mjs             pinned, redacted scanner adapter
tsconfig.harness.json         strict checkJs for tools and sensor tests
.githooks/pre-commit            optional index-consistent fast gate
.github/workflows/ci.yml        read-only verification and disposable PostgreSQL
.github/CODEOWNERS              requested review ownership
.github/pull_request_template.md acceptance and verification evidence
ui/                            Angular build and browser verification
docs/comment-quality.md       declaration contract standard
docs/harness-failures.md       sanitized failures and controls
```

## Ownership and effects

| Owner | Owned state/effects | Allowed dependencies |
| --- | --- | --- |
| runtime-probe.ts | HTTP admission, expiry, instance-local receipt observations | Node crypto/timers; injected protected operation |
| synthetic-lifecycle.ts | Per-invocation synthetic provider and Alchemy state | Alchemy and Effect |
| index.ts | Runtime credential checks, DB/SDK client lifetime, composition | Handler, synthetic engine, Node crypto, pg, OCI SDK |
| deployment.ts | Closed environment map; no file or cloud access | No imports |
| scripts/ | Private inputs, admin/setup requests, journals and CLI output | Other scripts, neon.ts, deployment allowlist; installed SDKs/Node |
| tools/ | Offline source analysis, Git inventory and verification | Pinned parser, Node APIs, pinned scanner |

The AST gate covers imports/re-exports, type imports and literal dynamic imports.
Type-only edges obey boundaries but do not create runtime cycles. New src owners
fail until registered. This is not proof of purity: ambient fetch, indirect loader
aliases and behavior inside dependencies require tests/review. The scanner checks
real comment tokens, not fixture strings. Test skip/focus detection and baseline
retention cover conventional static node:test declarations, not arbitrary test
factories or assertion semantics. Keep that limitation visible when extending tests.

## Commands and failure handling

| Point | Command | Response to failure |
| --- | --- | --- |
| Focused edit | Existing slice test or `pnpm test:harness` | Run checks for the affected boundary |
| Fast verification / hook | `pnpm check:fast` | Fix floor, style, type, contract or import failure |
| Pre-PR / CI | `pnpm check` | Application and browser tests, bundles, secret scan and dependency audits |
| DB boundary | `BERTH_TEST_POSTGRES_PORT=<loopback-port> pnpm test:setup-db` | Use a fresh disposable DB; never substitute a remote URL |

`pnpm lint:spacing` adds ESLint Stylistic's
[`padding-line-between-statements`](https://eslint.style/rules/padding-line-between-statements)
to the existing Biome checks. Require a blank line before and after function
declarations (plain, async, named exports and default exports), including before
the next declaration's leading JSDoc. Arrow expressions, class methods and overload
signatures are outside this declaration-spacing rule. Biome remains the formatter.
The pinned Babel parser reads TypeScript syntax without depending on the native
TypeScript build compiler's AST API. No Babel transforms or emitted code are used.
The gate covers `src`, `scripts`, `tests`, `tools`, `neon.ts` and its own config;
`pnpm lint` includes it, so the existing hook and CI enforce it automatically.
To fix violations, run `pnpm lint:spacing --fix`, then `pnpm check:fast`.
Synthetic controls in `tests/spacing.test.mjs` exercise rejection, correct spacing,
comment attachment, exported declarations and preservation of fixture strings.

Use the package.json Node/pnpm pins and run `pnpm install --frozen-lockfile`,
`pnpm ui:install` and `pnpm --dir ui exec playwright install chromium`. `pnpm check` needs **Gitleaks 8.30.1** on PATH. Use the checksum-verified
Linux x64 installation commands in .github/workflows/ci.yml; do not use an unverified
binary or silently skip the scanner. Other operating systems need their own verified
release artifact. Checks fail if the tool, registry, Git ancestor or input is missing.

Local floor checks use the merge base of HEAD and fetched origin/main. Fetch main
before qualification; `node tools/floor.mjs <full-ancestor-SHA>` reproduces a baseline.
PR CI runs the base revision's floor implementation, with a one-time bootstrap
restricted to PR #28's merge SHA. The floor permits an unchanged command followed
by ` && pnpm run namespace:check` when that additional script exists. It blocks
removing/renaming literal baseline tests or replacing an existing verification command.

The local hook is opt-in and never silently overwrites existing hooks. Inspect
`git config --get core.hooksPath`; if unused, enable with:

```bash
git config --local core.hooksPath .githooks
```

It requires tracked/unignored worktree inputs to match the index before checking;
partial staging is rejected rather than verified against different code. Ignored
build/dependency output remains outside that guarantee. Hooks can be bypassed; CI
and reviewed branch rules are the authority. The hook never stages or changes files.

## Enforcement limits

- The TypeScript AST parser is developer tooling. Backend compilation uses its own
  pinned TypeScript compiler. The Angular compiler is pinned separately in `ui/`.
- Legacy scripts still need documentation backfill before the documentation gate
  can expand. Coverage floors require measurements of the owned source first.
- Changes to assertions under preserved titles and changes to the sensors need
  review. The floor checks commands and test inventory, not assertion semantics.
- CI reports the stable `Berth verification / check` result. A GitHub ruleset is
  needed to require it and enforce code-owner approvals.
- Verification uses disposable PostgreSQL and synthetic provider fixtures. Live
  work follows the separately authorized scope and evidence requirements in SPEC.md.

## Local scanner setup (Linux x64)

These are installation commands, not a step run on every check. Choose a persistent
user-owned tools directory and add it to PATH; the repository does not change shell
startup files or require a global privileged install.

```bash
BERTH_TOOLS_DIR="$HOME/.local/share/berth-tools"
mkdir -p "$BERTH_TOOLS_DIR"
curl --fail --silent --show-error --location \
  --output "$BERTH_TOOLS_DIR/gitleaks.tar.gz" \
  https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_linux_x64.tar.gz
printf '%s  %s\n' \
  551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb \
  "$BERTH_TOOLS_DIR/gitleaks.tar.gz" | sha256sum --check && \
  tar -xzf "$BERTH_TOOLS_DIR/gitleaks.tar.gz" -C "$BERTH_TOOLS_DIR" gitleaks
export PATH="$BERTH_TOOLS_DIR:$PATH"
gitleaks version
```

Expected version: `8.30.1`. A mismatch fails `pnpm secrets`. Review and update the
scanner constant, CI checksum/version and these installation instructions together.

The fenced-state SQL sensor runs as `pnpm run test:fenced-db` after
`test:setup-db` against the disposable loopback PostgreSQL fixture. It exercises
actual transactions, permissions, takeover and backend termination. CI invokes it
explicitly; ordinary `pnpm test` runs only the adapter's deterministic unit tests.
Live Neon proof remains opt-in; see docs/trial/fenced-postgres.md.

`build:checkpoint` packages the independent hosted fenced-state proof. CI runs
`test:checkpoint-db` after the disposable DB bootstrap and adapter tests. Its
HTTP/credential tests are included in `pnpm test`; cloud deployment and schedules
are explicit operator actions outside all verification gates.

`pnpm test:ledger-db` exercises the owner-installed operation ledger against the
same disposable loopback PostgreSQL fixture, after `test:setup-db`. CI runs its
concurrency, protected-budget and actual backend-termination tests without cloud
credentials. `pnpm test` includes the ledger boundary's deterministic unit tests.

## Recovery CI partitions

Issue #51 separates ordinary verification (`verify`) from four `recovery` jobs.
Every job retains its 15-minute deadline. Each recovery job starts its own pinned
PostgreSQL service and bootstraps it before running the unchanged
`pnpm run test:recovery-db` command. `fail-fast: false` lets the other shards finish
if one fails; it does not turn failures into success. The stable `check` job runs
after both job groups and requires each result to be `success`, including when a
dependency failed, was canceled or skipped. Branch protection should require this
`check` result; external protection settings are not changed by the repository.

The crash suite discovers the same seven baseline trajectories on each shard,
sorts unique semantic labels and assigns label index modulo four. All assertions,
seeds, process kills, SQL fixtures, action/request budgets and test timeouts remain.
Each shard also runs the other recovery and security tests in full. This duplicates
some setup/work to reduce wall-clock runtime; it is not a reduction in coverage.
Unit tests prove deterministic, balanced, disjoint, complete partitioning and reject
invalid/empty shards. Workflow tests require all four matrix entries and exercise
the actual final shell gate against success/failure/cancellation/skipping outcomes.

Local reproduction, after `test:setup-db` on a fresh loopback database:

```bash
BERTH_TEST_POSTGRES_PORT=your_port BERTH_RECOVERY_SHARD=1/4 pnpm run test:recovery-db
```

Repeat with `2/4`, `3/4`, `4/4`; parallel runs need separate databases/ports.
Omit `BERTH_RECOVERY_SHARD` to retain the complete original local run. The existing
`BERTH_RECOVERY_POINT` diagnostic filter is local-only and cannot be combined with
a shard; CI rejects it. Diagnostic output records discovered and selected counts.
A canceled shard is incomplete and cannot establish checkpoint success.

GitHub semantics: [job dependencies and always()](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-jobs).

Local validation for #51 (2026-11-15): four fresh PostgreSQL 17 containers, each
bootstrapped with the real permission suite. All shards passed 47 tests each,
including repeated non-matrix recovery/security cases, with no skips/cancellations.
Their 34-label sets formed a disjoint union of all 136 discovered crash sites;
observed labels matched the selector's assignment. Full shard times were 147.3,
158.9, 151.1 and 155.0 seconds. Shard 1's main matrix accounted for 112.9 seconds.
These timings include shared local CPU contention, not hosted-runner setup; the
new PR's hosted CI must still confirm its runtime margin. No timeout was increased.
The full local check passed 146 application and 25 harness tests. A mutated selector
assigning every shard the same slice failed the completeness test as intended.
