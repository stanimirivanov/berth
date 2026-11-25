# Cloudflare Pages history release

The Angular app requests history from its own origin. Pages checks the owner's
browser access token and sends a separate service token to Neon. The Neon handler
projects retained records from SQL. Its public invocation URL still receives
traffic directly, but a request without the service token cannot read history.

The release steps on this page apply to standalone History. For the combined
Infrastructure and History release, follow the
[read-only Free-plan qualification and rollback runbook](../docs/trial/read-only-release.md).

## Verify locally

From the repository root, run `pnpm ui:install` and `pnpm check` using the pinned
toolchain. The history proxy tests exercise both Pages entrypoints against the
real Neon response handler with injected local data. The Angular build copies
`_routes.json` and `_headers` into `ui/dist/history/browser`. Only
`/api/history`, `/api/inventory`, and their descendants invoke Pages Functions.
Inventory uses the [dedicated read bindings](../docs/trial/managed-inventory-api.md#bindings-and-database-access).
Static UI requests
bypass the Function and receive the static security headers. The build emits
scoped rewrites for `/operations` and `/operations/:operation`. A top-level
`404.html` keeps other missing documents and assets at HTTP 404. The history
API catch-all keeps deeper misses in JSON.
[Pages routing](https://developers.cloudflare.com/pages/functions/routing/)
· [Pages rewrites](https://developers.cloudflare.com/pages/configuration/redirects/#advanced-redirects)

## Prepare a separately authorized release

1. Verify the account is on **Workers Free** in **Workers & Pages → Plans** and
   confirm Neon Free in **Billing**. Review current account usage and allow headroom
   for the new read service.
2. On the intended Neon branch, verify migration 008 is installed by the dedicated
   database owner. If required, [install the read projections](../docs/trial/operation-history.md#install-and-consume)
   separately with the owner role. Use the existing restricted database identity
   and both restricted connection URLs for the history service.
3. Build the dedicated `dist/history.zip` with `pnpm build:history`. Release only
   the `berthhistory89` Function on the intended branch with no triggers. Set
   `BERTH_HISTORY_TOKEN` to a freshly generated service token. Override both
   `DATABASE_URL` and `DATABASE_URL_UNPOOLED` with the restricted URLs. Leave
   executor and OCI configuration out of the history service. Copy this
   Function's **Invocation URL** from the branch's Functions view.
4. Create a Pages Direct Upload project for a deliberate operator-controlled
   release. In **Workers & Pages → your Pages project → Settings → Runtime**,
   set a compatibility date of **2024-11-11 or later** and select **Fail closed**
   under the Free-plan quota behavior. The compatibility date enables
   `cache: no-store` on upstream requests.
   [Compatibility flags](https://developers.cloudflare.com/workers/configuration/compatibility-flags/#enable-cache-no-store-http-standard-api)
5. Under **Settings → Variables and Secrets → Add**, select **Production** and
   enter the four bindings below. Leave preview bindings blank and disable
   previews where available. For the two token fields choose **Secret** (or
   **Encrypt**) before saving. Generate each token independently, for example
   with `openssl rand -hex 32` in a private terminal. Enter secret values using
   the dashboard, keeping them out of shell arguments, build output and Git.
   [Pages bindings](https://developers.cloudflare.com/pages/functions/bindings/)

| Name | Type | Value |
| --- | --- | --- |
| `BERTH_HISTORY_SITE_ORIGIN` | Text | Exact HTTPS origin you open in the browser, such as `https://your-project.pages.dev`. Use one origin. |
| `BERTH_HISTORY_NEON_ORIGIN` | Text | HTTPS origin of the dedicated Neon invocation URL, using its default `*.compute.*.neon.tech` hostname. Leave out paths and query strings. |
| `BERTH_HISTORY_ACCESS_TOKEN` | Secret | New browser token. Enter this value in the Angular history screen. |
| `BERTH_HISTORY_UPSTREAM_TOKEN` | Secret | Same service token as **Neon** `BERTH_HISTORY_TOKEN`. Keep it server-side. |

On a proxied custom domain you control, use Cloudflare Access with an allow
policy for your identity and a zone rate limit for `/api/history` and
`/api/history/*` where available. Redirect the production `pages.dev` alias to
the canonical origin when using that setup and verify the alias cannot read
history. The proxy still verifies its own token on every read. With a
`pages.dev`-only deployment, the app token provides the read gate and Cloudflare's
account quota limits Function invocations. Zone rate limiting may require an
existing managed domain.
[Pages custom domains](https://developers.cloudflare.com/pages/configuration/custom-domains/) ·
[Rate limiting](https://developers.cloudflare.com/waf/rate-limiting-rules/)

After authorization, build from the repository root with `pnpm build:ui`.
This generates the CSP hashes in the output `_headers`. Publish that file
with the browser assets from the same build. From
`ui/`, use Wrangler `pages deploy dist/history/browser --project-name YOUR_PROJECT --branch main`
so Wrangler discovers `ui/functions/`. Use the project's configured production
branch if it differs from `main`. Dashboard drag-and-drop uploads omit Pages
Function compilation. [Direct Upload](https://developers.cloudflare.com/pages/get-started/direct-upload/#functions)

## Verify and roll back

- Open the canonical URL in a fresh browser. Try a wrong browser token and check
  for an access error. Enter the browser token, load a page and select an operation.
  In the Network panel, verify both requests stay on the site origin and responses
  carry `Cache-Control: no-store`. Confirm a retained expired operation is
  readable and the partial verdict appears separately from its lifecycle status.
- Use the browser token for a direct GET against the Neon history origin and
  expect a 401. Check the production origin and aliases separately. Redact
  authorization headers before recording results.
- Inspect **Workers & Pages → your Pages project → Metrics** and the account's
  Workers usage after the checks. Free allocates 100,000 Workers requests per day
  across the account, and Pages Functions count toward it. Invalid API calls can
  consume this quota even when they never reach Neon. Each authorized proxy read
  makes at most one upstream request with a four-second deadline and a 128 KiB
  response cap. Neon invocation and database usage have separate limits. These
  controls provide no shared spending cap across Cloudflare and Neon.
  [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) ·
  [Pages limits](https://developers.cloudflare.com/pages/platform/limits/)
- To stop access, roll back to a known-good static deployment or remove the
  history Pages deployment. Disable the dedicated Neon history Function if no
  longer needed and rotate its service token if it may have been exposed. Keep
  migration 008 and retained history in place. The independent owner cleanup
  procedure and trial reserve remain outside this release.
