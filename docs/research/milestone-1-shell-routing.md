# Milestone 1 shell routing on loopback and Cloudflare Pages

Research for [#104](https://github.com/stanimirivanov/berth/issues/104) on main at
`1b45307`. The navigation and access decisions are recorded in
[ADR 0006](../adr/0006-land-on-infrastructure-and-link-to-the-review-inbox.md),
[ADR 0004](../adr/0004-make-operation-history-a-read-only-owner-console.md), and
[ADR 0005](../adr/0005-use-existing-history-api-with-independent-read-states.md).

## Current behavior

- The Angular build emits `index.html`, hashed JS and CSS, `_headers`, and
  `_routes.json` at the root of `ui/dist/history/browser`. The built document
  keeps a root base URL, so the browser requests the bundles from the root when
  entering a deep URL. The current app bootstraps one screen. The build has
  neither a top-level `404.html` nor a `_redirects` file.
  [Angular build](../../ui/angular.json) · [HTML entry](../../ui/src/index.html) ·
  [Bootstrap](../../ui/src/main.ts) · [Release guide](../../ui/cloudflare-history.md#verify-locally)
- The loopback preview sends `/api/` requests to the existing JSON API before
  handling files. It maps `/` to `index.html` and accepts only flat static file
  names with recognized types. `/operations` and `/operations/<id>` return
  empty HTTP 404s. A missing recognized file such as `/missing-bundle.js`
  falls into the catch block and returns 503. All of these responses get the
  preview's security headers.
  [Loopback server](../../scripts/history-server.ts)
- Pages only invokes Functions for the exact history root and its descendants
  because `_routes.json` includes `/api/history` and `/api/history/*`.
  The file-based handlers cover the list and one detail segment. A deeper path
  can match the invocation rule with no matching Function. Pages falls back to
  static serving when no Function matches. With no top-level `404.html`, the
  default SPA fallback serves the shell for unknown paths and missing files.
  This includes an unmatched path such as `/api/history/too/deep`.
  [Invocation rules](../../ui/public/_routes.json) ·
  [Pages Functions routing](https://developers.cloudflare.com/pages/functions/routing/) ·
  [Pages static serving](https://developers.cloudflare.com/pages/configuration/serving-pages/#single-page-application-spa-rendering)
- The Pages `/*` header rule supplies the CSP, `Referrer-Policy: no-referrer`
  and `X-Content-Type-Options: nosniff` on static responses. Functions supply
  their own headers. The history proxy returns JSON with `Cache-Control:
  no-store` and `nosniff`, including for a missing stored operation. The
  loopback API has the same JSON status for a missing record. Its raw malformed
  detail response is 400 after authorization, whereas the Pages proxy returns
  404 with valid bindings and origin.
  [Static rules](../../ui/public/_headers) ·
  [Pages custom headers](https://developers.cloudflare.com/pages/configuration/headers/#custom-headers) ·
  [Proxy](../../ui/edge/history-proxy.ts) · [Loopback API](../../src/trial/history-api.ts)

## Serving contract for implementation

1. Serve the same Angular document with HTTP 200 for the canonical paths `/`,
   `/operations`, and `/operations/<one segment>`, leaving the requested URL
   in the address bar. Put the two rules below in `ui/public/_redirects` and
   put a standalone `404.html` there with links to Infrastructure and Operation
   history. The top-level 404 makes all other static misses real HTTP 404s.
   Pages supports a local 200 rewrite and a named placeholder that matches one
   path segment. The rules only cover the reserved UI paths. Keep build assets
   at the root or in their own namespace. Canonical operation links omit
   trailing slashes. The two rules return 404 for slash-suffixed variants.
   [Pages rewrites and placeholders](https://developers.cloudflare.com/pages/configuration/redirects/#advanced-redirects) ·
   [Pages 404 behavior](https://developers.cloudflare.com/pages/configuration/serving-pages/#not-found-behavior)

   ```text
   /operations / 200
   /operations/:operation / 200
   ```

2. Use the same path boundary in the loopback preview after its existing API
   dispatch. Resolve the allowed document paths to the constant `index.html`
   filename and keep the flat filename and MIME checks for real assets. Serve
   the standalone error document with status 404 for unknown UI URLs and
   return 404 for missing assets. Distinguish a missing asset from failures
   reading the shell or other unexpected I/O failures, which can still return
   503. Keep the current CSP and loopback boundary.
   [Loopback server](../../scripts/history-server.ts)
3. Keep `_routes.json` scoped to the history API and add a least-specific
   `ui/functions/api/history/[[rest]].ts` entrypoint using the existing proxy.
   Pages gives the list and single-segment detail routes priority. The
   catch-all sends deeper history paths to the proxy's existing JSON error
   path, so a path like `/api/history/too/deep` returns JSON 404 for a GET
   with valid bindings and site origin. Outside that namespace, an unmatched
   URL such as `/api/history-other` returns Pages' static HTTP 404. Keep
   private API responses under the handlers' existing cache and authorization
   rules.
   [Pages route specificity and multipath segments](https://developers.cloudflare.com/pages/functions/routing/#multipath-segments) ·
   [Current invocation rules](../../ui/public/_routes.json) ·
   [Proxy](../../ui/edge/history-proxy.ts)
4. Let Angular decide whether the detail segment is a lowercase UUIDv4.
   A malformed segment loads the shell and shows **Invalid operation link**
   with a way back to history, with zero history requests for that URL. A
   valid link can wait for the tab-memory token and then request detail.
   An authorized detail API 404 shows **Operation not found** and keeps the
   list usable. An in-app route with no match can use a final Angular wildcard
   to show **Page not found** and links back to the main routes. A direct load
   of an unknown path gets the static HTTP 404.
   [Angular parameterized and wildcard routes](https://angular.dev/guide/routing/define-routes#route-url-paths) ·
   [Saved-link behavior](../adr/0004-make-operation-history-a-read-only-owner-console.md#navigation-and-detail) ·
   [History error states](../adr/0005-use-existing-history-api-with-independent-read-states.md#loading-access-and-recovery)

## Local evidence and implementation checks

Built the production Angular and backend output in an isolated checkout.
Confirmed that the emitted `_headers` and `_routes.json` matched their
sources byte for byte. Ran `node --test dist/tests/history-api.test.js
dist/tests/history-proxy.test.js` successfully. The existing proxy tests use
injected responses for successful reads and upstream 404s.
[API tests](../../tests/history-api.test.ts) · [Proxy tests](../../tests/history-proxy.test.ts)

Ran the unchanged loopback preview and Wrangler Pages dev 4.166.0 on loopback.
Compared the unchanged Pages build with a disposable copy that added the two
rewrites, the standalone 404 and the proposed catch-all. Confirmed the following
responses by status, content type and body. The Pages shell, static error
document and real CSS had all three static security headers. No live Pages or
Neon requests were needed.
[Pages local development](https://developers.cloudflare.com/pages/functions/local-development/)

| Request | Current loopback | Current Pages dev | Proposed Pages fixture |
| --- | --- | --- | --- |
| `/` | 200 shell | 200 shell | 200 shell |
| `/operations`, `/operations/<uuid>`, `/operations/not-a-uuid` | 404 empty | 200 shell | 200 shell, no redirect |
| `/operations/`, `/operations/not-a-uuid/`, `/operations/a/b`, `/unrecognized` | 404 empty | 200 shell | 404 static error document |
| `/missing-bundle.js` | 503 text | 200 shell | 404 static error document |
| Existing emitted CSS | 200 CSS | 200 CSS | 200 CSS |
| `/api/history` without a request token | 503 JSON, no local service token configured | 401 JSON | 401 JSON |
| `/api/history/bad` | 503 JSON, no local service token configured | 404 JSON | 404 JSON |
| `/api/history/too/deep` | 404 JSON | 200 shell | 404 JSON |
| `/api/history-other` | 404 JSON | 200 shell | 404 static error document |

During implementation, run HTTP checks on both local servers using the
production output. Check document status and HTML identity, the unchanged
requested URL, actual CSP/referrer/nosniff values, asset MIME types, and the
missing bundle's HTTP 404 body. For list access and an authenticated missing
detail, use the existing injected fixtures and check JSON content type, API
status and `no-store`. Run browser tests against the updated loopback preview
for direct navigation, refresh without a retained token, the malformed link
with zero history requests, and an authorized missing detail with the list
still usable. Keep these browser checks separate from the HTTP smoke tests,
which only establish document delivery and HTTP error behavior.
[Existing browser harness](../../ui/playwright.config.ts) ·
[History browser tests](../../ui/tests/history.spec.ts)
