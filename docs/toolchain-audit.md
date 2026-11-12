# Toolchain dependency audit

Reviewed 2026-11-12 for issue #2. Direct dependencies are exact pins and pnpm locks
transitive dependencies. Installation runs with `ignoreScripts: true`; no package
install scripts have been approved. The native TypeScript/Biome executables are
provided by their platform packages, not an enabled install hook.

Issue #3 recheck (2026-11-12): the same seven findings remain, with no high or
critical findings. The setup command uses built-in `fetch` and `pg` directly; it
does not invoke the Neon CLI, its development server, bundler or diff paths.
`pg` 8.23.1 was already present transitively and is now an exact development pin;
the only new installed package is MIT-licensed `@types/pg` 8.23.1. No dependency
scripts or forced audit fixes were enabled. The existing CLI deferral below
continues to apply; it does not cover future CLI deployment use.

The pre-migration `npm audit` reported seven affected packages: six moderate and one low, all in the
Neon CLI development dependency tree. No high or critical findings were reported.
The five underlying advisory groups are:

| Package | Advisory | Assessment for this slice |
|---|---|---|
| `@hono/node-server` | [Static path traversal](https://github.com/advisories/GHSA-frvp-7c67-39w9), [WebSocket DoS](https://github.com/advisories/GHSA-9mqv-5hh9-4cgg), [double decoding](https://github.com/advisories/GHSA-rmxm-3fg6-px4f) | No Hono server or Neon dev server runs in the smoke suite. Reassess before serving requests. |
| `diff` | [Patch parsing DoS](https://github.com/advisories/GHSA-73rr-hh4g-fpgx) | The smoke suite does not parse patches or invoke Neon diff commands. |
| `glob` | [Cancellation bypass](https://github.com/advisories/GHSA-3g3m-2fjr-6pw4) | Used transitively by Neon configuration/build tracing, not this TypeScript build or Node test runner. |
| `minimatch` | [Glob amplification DoS](https://github.com/advisories/GHSA-g3hv-75wg-m249) | Same configuration/build path; do not process untrusted project patterns. |

`@neon/config-runtime`, `@vercel/nft` and `neon` are also flagged because they depend
on affected packages. These advisories are deferred for the offline harness only.
The audit's suggested Neon downgrade to 2.1.2 crosses major versions and does not
preserve the planned Functions tooling, so it was not applied. No forced fixes,
major-version transitive overrides or audit suppressions were added.

Recheck by **2026-11-19**, or before issue #4 invokes Neon development/build/deploy
paths, whichever comes first. That work must evaluate compatible patched releases
and the paths actually exercised; this deferral is not approval for hosted use.
Run `pnpm audit` from the repository root. The current nonzero result is an explicit
known limitation, not a clean security verdict.

Package ownership and licenses were checked in official registry metadata:
Alchemy and Neon are Apache-2.0, Effect/TypeScript and declaration packages are MIT,
OCI is UPL-1.0 OR Apache-2.0, and Biome is MIT OR Apache-2.0.

Sources: [Alchemy installation](https://alchemy.run/getting-started/),
[Neon CLI installation](https://neon.com/docs/cli/install), official npm metadata,
and package-manager advisory results for the lockfiles. Hosted compatibility is
separately tracked in issues #4–#6.

## pnpm migration — issue #3 revision

The project now pins pnpm 12.16.1 and uses only `pnpm-lock.yaml`. Import preserved
all application dependency names and versions from the npm lockfile. Two scoped
version overrides retain `graceful-fs` 4.2.12 and `tar` 7.5.23 because the importer
otherwise selected older patches. The lockfile also records pnpm's own binaries
in its separate package-manager document.

pnpm generated exact release-age exceptions for 16 already-reviewed package
versions from that original graph. Each exception was checked against the old
lockfile; no new application versions were exempted. `minimumReleaseAgeStrict`
is enabled so future exception additions need explicit handling. This preserves
the reviewed pins without globally disabling pnpm's release-age policy.

Native `pnpm audit` reports six advisories (five moderate, one low), with zero
high/critical findings: the same Hono, diff, glob and minimatch advisory set above.
Its advisory count differs from npm's count of affected/dependent packages.
Install scripts remain disabled in `pnpm-workspace.yaml`; no build approvals or
audit suppressions were added. The same CLI reachability deferral applies.
