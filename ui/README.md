# Angular operation history

A private, read-only history screen using Angular 22 and NgRx Signal Store.
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

The history access form and loading indicators use pinned Angular Material.
The build links the theme as same-origin CSS and hashes runtime component
styles. Material motion is disabled for the static CSP. Keep the visible
loading text alongside progress.
[Material qualification](../docs/research/angular-material-pages-csp.md)

## History accessibility qualification

The production Chromium suite runs full-page axe scans for the History access
prompt, populated Review inbox, loaded operation detail, and recoverable refresh
error with retained rows. Any reported WCAG 2.2 A or AA violation fails the suite.
Each state uses synthetic History responses and the production CSP.
Run just these scans after building the backend and UI.

```bash
pnpm build && pnpm build:ui
pnpm test:ui history-accessibility
```

Release qualification stays pending until the release candidate passes the
desktop screen-reader checklist and its results are recorded. The
[Orca and Chromium results in PR #185](https://github.com/stanimirivanov/berth/pull/185)
document the earlier announcement and focus changes. Automated checks cover
rules axe can evaluate. The screen-reader pass checks what the browser actually
announces and where keyboard focus lands.

### Desktop screen-reader pass

Build as above and start the screen reader in a desktop session. Use one desktop
browser and screen-reader combination. Firefox with Orca is the Linux option. The
commands below run the existing browser scenarios against loopback with
synthetic responses and a fixture token. Install the selected browser and
substitute its Playwright name for `firefox` if using a different combination.

```bash
pnpm --dir ui exec playwright install firefox
pnpm test:ui history.spec.ts --browser firefox --debug -g 'Material access on a saved link|loading, empty, unavailable|detail refresh retains|malformed operation links|returning from desktop detail'
```

Use **Step over** in Playwright Inspector until it pauses at an assertion
for the state you want to observe. Give the browser window focus and listen
to the announcement or read the screen reader's speech output. On the saved
link, stop at the loading announcement assertion while the response is held.
Then step to the `Operation details updated.` assertion and stay paused while
the browser receives the released response. Finish listening before resuming,
since the test closes the page when it ends.

| Scenario | What to observe |
| --- | --- |
| **Material access on a saved link** | After the saved-link prompt appears, Tab to the token field before the test fills it. Hear “History access token” and the tab-memory help. Step through Enter submission and listen for the focused “Operation details” heading and loading message while the test holds the detail response. After the response is released, hear the updated detail announcement. |
| **History has loading, empty, unavailable and unauthorized states** | After Load history, hear “Loading operation history…” before the held response is released, then hear the empty result. On Refresh history, hear the unavailable warning. When Retry succeeds, hear the updated result and confirm an operation is available. |
| **Detail refresh retains its timestamp on failure** | On Refresh detail, hear the recoverable stale-data warning and confirm the existing detail is still available. After the retry that returns a successful result, hear the updated detail announcement. |
| **Malformed operation links** | At `/operations/%ZZ?view=raw&name=a%2Bb#record%20notes`, hear the focused “Invalid operation link” heading. Confirm the address retains its query and fragment. The scenario checks that no History request was made. |
| **Returning from desktop detail** | Track the operation selected on the older page. Activate “Back to inbox” and hear the same operation row receive focus, including its ID, status, UTC time and summary. |

Record the date, tested commit, OS, browser and screen-reader names and versions,
and the result for each row in the release evidence. Include what was actually
spoken and focused, and record missing or duplicated announcements and failures.
Repeat the manual checks when a change affects token help, History loading,
refresh or error announcements, saved-link or detail focus, or Review inbox row
content and focus restoration.

## Reuse the Review inbox controls in Infrastructure

- Use the shared Azure theme and outlined Material cards for offering surfaces.
  Give each offering a labelled section with its own heading. Keep the card
  decorative and the qualification and presence labels tied to their evidence.
- Use outlined Material buttons for **Refresh** and **Retry**, and a text
  button for **Show more**. Preserve the visible loading message with Material
  progress and retain existing instance rows when a page fails.
- Keep **Review operation** an anchor to the saved operation URL. Use a
  labelled Material navigation list when every row is one link, as in the
  Review inbox. If an instance row contains other controls, use a regular
  list and keep the operation link separate.
- Qualify added controls with the production CSP and bundle checks before
  release. Keep styles same-origin, Material motion disabled and Pages static.

## Browser owner session

History and Infrastructure use the shell’s owner session. The
session keeps one bearer token in tab memory and verifies it only after a
current protected read decodes successfully. A failed first read leaves
access unverified and can be retried. A detail 404 remains a History result.

Each feature owns its snapshots, request identities and retries. Register a
synchronous clear handler with the session to erase protected snapshots and
queued reads on disconnect or denial. Check request identity before applying
an awaited reply. History keeps its serial dispatch and saved-detail priority.
Leaving History discards pending pane requests and preserves settled snapshots.
Infrastructure preserves its loaded rows during pagination and failed refreshes.
When a refresh has more pages, previously loaded instances remain visible
until the refreshed traversal reaches its end.
The Inventory integration will keep the offering catalog visible regardless
of protected access.

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
- Enter the history token and click **Load history**. The Review inbox groups
  records by whether they need attention. Open a record to see its follow-up
  reasons, owner-procedure links and lifecycle evidence.
- Use **Older operations**, **Newest operations** or **Refresh history** to
  browse. On a narrow screen, detail takes the full width. **Back to inbox**
  restores the page the detail opened from and focuses the selected row if present.
  There is no automatic polling or retry.
- **Disconnect** clears the in-memory token and records and invalidates late
  responses. Reloading the page also clears access; no browser storage or cookies
  are used. Entering a token does not connect to any cloud provider API.
- Open or refresh `/operations` or `/operations/<operation-id>` directly.
  Saved links use the history token prompt after a page load. The History URL
  serializer checks the raw ID in a single-segment `/operations/<operation-id>`
  URL before Angular decodes it or interprets router syntax. An invalid ID
  focuses **Invalid operation link** without a History API read. The address
  retains the original path, query, and fragment. Valid IDs and other URL
  shapes delegate to Angular's default serializer. The static server still
  returns 404 for paths such as `/operations/` and `/operations/a/b`.
- The read service creates one restricted connection per admitted read, establishes
  a read-only transaction, checks SQL privilege drift and invokes only the two
  owner-installed history read functions. Session statement timeout is 2 seconds,
  query timeout 5 seconds, connect timeout 3 seconds. No lease or ledger write.
  Concurrent reads in one service instance return unavailable rather than queue.

A missing migration, invalid database credentials or service outage gives a generic
unavailable state. A 401 clears the token and protected state, then prompts for
a new token at the same URL. A 403 clears the same state and directs you to the
Berth URL configured for the deployment. A detail 404 clears only the missing detail.
Stored records remain readable after their execution expiry.

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
