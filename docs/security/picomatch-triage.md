# Picomatch advisory assessment — issue #59

**2026-11-18: unresolved, release blocked.** The authoritative native audit gate
remains `pnpm audit --audit-level high` inside `pnpm check`. This investigation
provides no waiver, suppression, fork, override, dependency downgrade or cloud
activation. PRs #50 and #60 remain drafts; the one-trial exception stays consumed.

## Version and upstream evidence

The committed pnpm lockfile resolves exactly one picomatch version, **4.0.7**.
`pnpm why picomatch` identifies production Alchemy 2.0.0-beta.86, its
`tinyglobby@0.2.17` / `fdir@6.5.0` path, development Cloudflare/SQL adapters,
Neon's packaging graph through `@vercel/nft` / `@rollup/pluginutils`, and the
Stylistic ESLint plugin. The native audit reports 26 dependency paths; repeated
paths do not mean 26 independently installed versions.

The [reviewed advisory](https://github.com/advisories/GHSA-fc5q-39xc-vjpf), updated
November 17, identifies single-branch repeated-extglob ReDoS, affects <=4.0.7 and
lists no patched version. `pnpm view picomatch version` on November 18 returned
4.0.7. An upgrade or downgrade within that affected range cannot resolve the gate.

The advisory's linked [upstream PR #194](https://github.com/micromatch/picomatch/pull/194)
is open and primarily concerns leading question marks in extglob bodies. Its
author explicitly states it is not a security fix. Its related changes do not
establish a reviewed fix for every single-branch shape described in this advisory.
Do not install that contributor branch or claim it remediates the advisory.

## Reachability assessment

| Surface | Evidence from pinned source / Berth | Assessment |
| --- | --- | --- |
| Hosted Alchemy resource selection | `alchemy/lib/ResourceSelection.js` constructs matchers from include/exclude patterns, but returns before matching when both are absent. `src/trial/executor-resources.ts` calls `Plan.make(stack)` and `Plan.destroy` with fixed stack identity and no pattern options. | Vulnerable library is in the production dependency graph. No attacker-selected resource glob was identified in the current fixed trial path; this is not removal of the vulnerable dependency. |
| Hosted HTTP/schedule inputs | `src/trial/api.ts` accepts an empty preview object or the signed preview for submission; `live-hosted.ts` rejects control bodies; scheduler validates its fixed envelope. Bucket/object names and the one operation are fixed by durable intent. | No HTTP pattern field flows to Alchemy selection in the inspected composition. This conclusion applies to current routes, not arbitrary future Alchemy APIs. |
| Alchemy administrator/CLI features | `alchemy/src/Nuke.ts` accepts include/exclude globs; `Command/Memo.ts` constructs matchers and filesystem glob queries. | Malicious CLI/config patterns can reach matching if these broader features are used. Berth's fixed runtime does not call Nuke/Memo. Developer-controlled input still has availability risk, especially on shared CI. |
| Bundling / development | `Bundle/NamespaceImportPlugin.ts` uses package-selection globs; Cloudflare Prebuilt/Python/Rolldown sources use matching/globbing. Neon packaging includes tracing/plugin dependencies. Berth's `neon.ts` contains fixed source/package descriptors. | Treat repository/configuration/CLI input as the trust boundary. No claim that every transitive path is unreachable; build-time dependency presence is not production exposure proof, and trusted configuration is not a vulnerability fix. |
| Lint / tests | Stylistic ESLint dependency path and local test/tooling graph. | Contributor-controlled configuration/source can affect developer/CI work. Current CI already executes repository code; do not accept arbitrary patterns as safe merely because this is tooling. |

This is a targeted source review, not whole-program taint analysis. Dependency
presence and matcher construction are established; universal non-reachability is
not. Do not turn the current fixed-input architecture into an audit exemption.
The stopped deployment provides no currently active hosted attack surface, but
future deployments/builds still use the affected dependency until remediated.

## Bounded local reproduction

On Node 24.22.3, resolve picomatch through the pinned Alchemy dependency and run
each case in a separate subprocess. The parent enforces a 1,500 ms wall timeout;
never run the adversarial match in the agent, test runner or hosted event loop.

```js
const { spawnSync } = require('node:child_process');
const { createRequire } = require('node:module');
const fromAlchemy = createRequire(require.resolve('alchemy'));
const modulePath = fromAlchemy.resolve('picomatch');
for (const [pattern, length] of [['a*', 30], ['+(*a)', 32]]) {
  const code = `const pm=require(${JSON.stringify(modulePath)});
    const matched=pm(${JSON.stringify(pattern)})('a'.repeat(${length})+'!');
    console.log(JSON.stringify({matched}));`;
  const result = spawnSync(process.execPath, ['-e', code], {
    timeout: 1500, encoding: 'utf8',
  });
  console.log({ pattern, status: result.status, signal: result.signal,
    error: result.error?.code, output: result.stdout.trim() });
}
```

Observed control: exit 0, matching completed in approximately 1 ms. Adversarial
case: `ETIMEDOUT`, terminated with SIGTERM and no matching result. This supports
the installed version's pathological behavior; wall-clock thresholds are machine
specific and do not prove a complete fix. No attack was sent to a live service.

No production behavior is changed in this triage PR. The TDD documentation-only
exception applies. The reproduction is diagnostic evidence, not a green regression
assertion that accepts timeouts as secure. Before adopting any remediation, write
its failing-first bounded regression and verify benign glob compatibility alongside
it. A passing timing example alone cannot replace the package audit or a review of
other repeated/nested/alternative extglob shapes.

## Decision, owner and next review

Retain exact dependency pins, install-script blocking (`ignoreScripts: true`),
release-age policy and the complete audit gate. Do not remove Alchemy or change the
approved architecture merely to hide the reported dependency in this bounded issue.
No compatible published remediation is established as of this assessment.

Owner: Berth maintainer, tracked by #59. **Next review: 2026-11-20**; this is a
review date, not permission to deploy or bypass failed checks. At review:

1. Recheck official advisory status and published release/changelog/fix provenance.
2. Assess all affected paths. If a fix exists, propose a separate bounded dependency
   PR with its regression first, pinned resolution and minimal lockfile diff.
3. Run frozen install under the existing script policy, native audit, full harness,
   relevant integration tests and hosted bundle builds locally. No live run.
4. Keep release blocked if there is no supported fix. A maintained backport/fork
   requires its own explicit design/security review and provenance; it cannot be
   silently substituted under the current version or represented as an official fix.

Completion of this assessment does not close the vulnerability. Keep #59 open
until remediation is verified, or a separately reviewed resolution replaces it.

## Verification record — 2026-11-18

`pnpm check` passed its fast gates, 158 application tests, 28 harness tests,
runtime-probe build and secret scan, then failed the native dependency audit:
one high, seven moderate and one low advisory. The high finding remains the
picomatch advisory above. `pnpm run build:live-executor` passed locally. No source,
dependency, lockfile, install policy, CI gate or recovery test was changed.
The final documentation passed diff and commit-time fast checks. No cloud
credentials were read and no cloud request/deployment/trial was made by this task.

## Proposed temporary exception

The owner requested preparation of a [time-limited exception proposal](picomatch-exception-proposal.md).
It is inactive and limited to documentation review/merge, with a fixed November 25
UTC expiry and a November 20 upstream review. It specifies required enforcement,
negative tests and removal criteria. No audit suppression or policy activation is
implemented by this document; the unresolved finding and #59 remain open.
