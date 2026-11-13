# Berth coding harness

Start at AGENTS.md and the guide nearest the affected file. This harness adapts the
read-only `fleetiq-simulator` reference to Berth's Node/TypeScript trial; no reference
files are modified or imported at runtime. Berth has no Angular application today.

```text
AGENTS.md                      task intake, context routing, Plan/Execute/Verify
CONSTRAINTS.md                 written quality floor
HARNESS.md                     ownership, gates, adoption and rollout
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
| Focused edit | Existing slice test or `pnpm test:harness` | Reproduce the first failing control before editing |
| Fast verification / hook | `pnpm check:fast` | Fix floor, style, type, contract or import failure |
| Pre-PR / CI | `pnpm check` | Full suites, bundle, secret scan and live advisory audit must pass |
| DB boundary | `BERTH_TEST_POSTGRES_PORT=<loopback-port> pnpm test:setup-db` | Use a fresh disposable DB; never substitute a remote URL |

Install dependencies with `pnpm install --frozen-lockfile` and the package.json Node/
pnpm pins. `pnpm check` needs **Gitleaks 8.30.1** on PATH. Use the checksum-verified
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

## Adoption decisions

| Reference control | Berth decision |
| --- | --- |
| Scoped guides, project map, PEV, quality contract | Adopted with Berth owners and existing GitHub workflow |
| Source/tool JSDoc checks | Adapted to a pinned AST parser; actual trial contracts backfilled |
| Import direction, runtime cycles, negative fixtures | Adapted; preserve legal type-only admin/recovery references |
| Verification floor and trusted-base execution | Adopted for static test retention and additive command checks |
| Private path and redacted secret scanning | Adapted to OCI/Neon files; no simulator identity rules |
| Fast/full entry points, safe opt-in hook, PR template | Adopted; no automatic mutation or deployment |
| Read-only CI and version parity | Adopted, with existing loopback PostgreSQL integration test |
| 90/85% simulator coverage floors | Not transferable; measure Berth source inventory and groups first |
| AST ambient wire checks, native TS stripping rule | Not applicable to Berth's hosted integration and compiled TS |
| Image/TCP/device/Rust/Angular checks | Not applicable to this repository |
| Recurring security workflow | Deferred until owner chooses schedule/Actions budget; PR/main/manual scans exist |
| Test semantic weakening and policy-file trust | Review remains required; static checks are not a complete tamper-proof harness |

The dependency additions are developer-only `typescript-ast` (TypeScript 5.9.3,
parser API) and `yaml` 2.9.1 (workflow structure). The build/compiler remains 7.0.2.
No incompatible ESLint peer override, framework migration or production dependency
change is required.

## Progressive hardening and external controls

1. **This PR:** establish and exercise the controls above, including failing fixtures,
   read-only sensor review. Report any incomplete verification.
2. **After merge:** the owner configures a main ruleset requiring the actual
   `Berth verification / check` status, code-owner approval for harness changes,
   no force pushes and restricted bypass. Test it with a deliberately failing PR.
   CODEOWNERS alone does not enforce review; no ruleset change is claimed here.
3. **Documentation/coverage ratchet:** inventory legacy script contracts and backfill
   them in bounded issues. Measure line/branch coverage across all owned source,
   including unloaded modules, then set per-owner floors. Do not copy simulator
   percentages or report mocked cloud tests as live proof.
4. **Policy integrity:** strengthen trusted-base controls to detect assertions removed
   under unchanged titles, aliases/factories, semantic checker changes and coverage
   reductions. The current floor does not freeze every policy file; code-owner review
   and external branch rules must cover intentional changes.
5. **Hosted work:** preserve #5/#6 durable-state/feasibility gates and #13 before live
   OCI writes. Live trials remain authorized operator actions with private evidence,
   not an automatic side effect of CI. Periodic security cadence is a later decision.

The design uses focused guides before changes and deterministic sensors afterward,
following [Fowler's guides/sensors framework](https://martinfowler.com/articles/harness-engineering.html).
Repository-local knowledge and mechanically checked boundaries follow the approach
in [OpenAI's harness engineering account](https://openai.com/index/harness-engineering/).
Neither approach makes arbitrary model output deterministic or replaces human review.

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
