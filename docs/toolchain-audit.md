# Toolchain dependency audit

Reviewed 2026-11-12 for issue #2. Direct dependencies are exact pins and npm locks
transitive dependencies. Installation runs with `ignore-scripts=true`; no package
install scripts have been approved. The native TypeScript/Biome executables are
provided by their platform packages, not an enabled install hook.

Issue #3 recheck (2026-11-12): the same seven findings remain, with no high or
critical findings. The setup command uses built-in `fetch` and `pg` directly; it
does not invoke the Neon CLI, its development server, bundler or diff paths.
`pg` 8.23.1 was already present transitively and is now an exact development pin;
the only new installed package is MIT-licensed `@types/pg` 8.23.1. No dependency
scripts or forced audit fixes were enabled. The existing CLI deferral below
continues to apply; it does not cover future CLI deployment use.

`npm audit` reports seven affected packages: six moderate and one low, all in the
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
Run `npm audit` from the repository root. The current nonzero result is an explicit
known limitation, not a clean security verdict.

Package ownership and licenses were checked in official registry metadata:
Alchemy and Neon are Apache-2.0, Effect/TypeScript and declaration packages are MIT,
OCI is UPL-1.0 OR Apache-2.0, and Biome is MIT OR Apache-2.0.

Sources: [Alchemy installation](https://alchemy.run/getting-started/),
[Neon CLI installation](https://neon.com/docs/cli/install), official npm metadata,
and npm's advisory results for the committed lockfile. Hosted compatibility is
separately tracked in issues #4–#6.
