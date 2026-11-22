# Angular operation history

A private, read-only history screen using Angular 22, NgRx Signal Store and Effect.
No operation can be created, resumed, cleaned up or settled from this screen.
The visible partial/no-go verdict remains independent of stored lifecycle outcomes.

## Local build and verification

From the repository root:

```bash
pnpm ui:install
pnpm --dir ui exec playwright install chromium
pnpm build
pnpm build:ui
pnpm test:ui
pnpm build:history
```

`pnpm check` includes the frontend lint, strict Angular/template compilation,
production browser tests, independent history bundle and both dependency audits.
CI installs Chromium and runs the same checks. The UI is a separate package because
Angular 22 requires TypeScript 6; the Node trial keeps TypeScript 7. Versions and
both lockfiles are pinned. Dependency lifecycle scripts remain explicitly disabled.

Use `pnpm build:ui` to produce preview and release assets together with their
CSP hashes. The loopback server reads the generated Pages `_headers` file
when serving HTML.

## Preview actual retained records

Migration 008 from PR #88 must first be installed by the owner in the dedicated
Neon database. This PR installs nothing and makes no cloud requests during tests.

- Use an isolated server environment containing only both restricted database URLs
  and an independently generated `BERTH_HISTORY_TOKEN` (32–128 URL-safe characters).
  Supply these privately, not in Git, chat, shell command arguments or browser code.
- Do not reuse the live trial token. Do not include any OCI credentials or Neon
  administrator API key. No provider credentials belong in the browser or service.
- Run `pnpm history:serve` from the repository root after building the UI. It binds
  only `http://127.0.0.1:4201` and serves the UI/API at the same origin, with a strict
  CSP and no CORS. Open that exact URL.
- From **Infrastructure**, open **Operation history**. The interim Infrastructure
  page shows that inventory is unavailable and makes no inventory request.
- Enter the history token, click **Load history**, and choose an operation for
  detail. Use **Older operations**, **Newest operations** or **Refresh history**
  to browse. There is no automatic polling or retry.
- **Disconnect** clears the in-memory token and records and invalidates late
  responses. Reloading the page also clears access; no browser storage or cookies
  are used. Entering a token does not connect to any cloud provider API.
- Use in-app navigation in this slice. Direct serving of operation URLs in the
  preview server and Pages is tracked by
  [M01-PR2](https://github.com/stanimirivanov/berth/issues/113).
- The read service creates one restricted connection per admitted read, establishes
  a read-only transaction, checks SQL privilege drift and invokes only the two
  owner-installed history read functions. Session statement timeout is 2 seconds,
  query timeout 5 seconds, connect timeout 3 seconds. No lease or ledger write.
  Concurrent reads in one service instance return unavailable rather than queue.

A missing migration, invalid database credentials or service outage gives a generic
unavailable state. A 401 requires disconnecting and entering a valid token. Unknown
records return 404. Stored records remain readable after their execution expiry;
this is not permission to perform any expired cloud work.

## Hosted boundary and limitations

`pnpm build:history` writes `dist/history.zip`, a separate Neon Function descriptor
with no schedule or OCI dependency. For an authorized hosted release, follow the
[Cloudflare Pages history guide](cloudflare-history.md) for the same-origin proxy,
separate tokens, Free-plan controls and rollback. The loopback preview server is
for local use.

Browser tests use synthetic HTTP responses and the real built Angular application,
production static server and CSP, not live Neon records. They cover keyboard
selection, pagination, detail/budgets, loading, empty, unauthorized/unavailable,
no token persistence and 320/768/1024/1440px layouts. No live trial or migration was
performed. Browser inspection does not establish a complete screen-reader audit.

Application counters are not billed Functions usage or remaining free allowances.
History reads themselves consume database/hosting resources when deployed; the
read service does not debit or recreate a trial's protected cleanup reserve.
Unlimited public requests cannot be capped by application concurrency guards.

Sources: [Angular compatibility](https://angular.dev/reference/versions),
[NgRx Signal Store](https://ngrx.io/guide/signals/signal-store).

Local results: canonical verification passed with 181 application tests and 31
harness tests, production Angular and independent history function builds, secret
scan and both dependency audits. Four Chromium scenarios passed on production
assets behind the preview server's CSP. Desktop/mobile screenshots were inspected;
populated layouts were checked at all four widths. The frontend audit reported no
known vulnerabilities; the unchanged backend graph retains seven moderate and
one low advisory, with no high/critical findings.
