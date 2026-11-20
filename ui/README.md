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
  CSP and no CORS. Open that exact URL and enter the history token.
- Click **Load history**, choose an operation for detail, and use **Older operations**,
  **Newest operations** or **Refresh history**. There is no automatic polling/retry.
- **Disconnect** clears the in-memory token and records and invalidates late
  responses. Reloading the page also clears access; no browser storage or cookies
  are used. Entering a token does not connect to any cloud provider API.
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
with no schedule or OCI dependency. Building does not deploy. Cloudflare can serve
`ui/dist/history/browser`, but a reviewed same-origin `/api/history` proxy to the
private read function, TLS, server secret injection and platform access/rate limits
remain a separate owner deployment decision. Do not embed database URLs or tokens
in a Cloudflare static build or open cross-origin access to work around this boundary.
The loopback preview server is not an Internet-facing hosting server.

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
