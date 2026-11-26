# Cloudflare Pages history release

The Angular app requests history from its own origin. Pages checks the owner's
browser access token and sends a separate service token to Neon. The Neon handler
projects retained records from SQL. Its public invocation URL still receives
traffic directly, but a request without the service token cannot read history.

History ships with Infrastructure in the read-only Pages candidate. For the
binding maps, deployment, hosted smoke tests and rollback, follow the
[read-only Free-plan qualification and rollback runbook](../docs/trial/read-only-release.md).

## Verify locally

From the repository root, run `pnpm ui:install` and `pnpm check` using the pinned
toolchain. The history proxy tests exercise the Pages entrypoints against the
real Neon response handler with injected local data. `pnpm build:ui:read-only`
stages the Pages root at `ui/dist/read-only` with `browser/`, `functions/` and
`edge/`. History and Inventory paths invoke the two read proxies. Retry is
absent from both the browser and Functions. Inventory uses its
[dedicated read bindings](../docs/trial/managed-inventory-api.md#bindings-and-database-access).
Static UI requests bypass the Functions and receive the static security headers.
The build emits scoped rewrites for `/operations` and `/operations/:operation`.
A top-level `404.html` keeps other missing documents and assets at HTTP 404.
The History API catch-all keeps deeper misses in JSON.
[Pages routing](https://developers.cloudflare.com/pages/functions/routing/)
· [Pages rewrites](https://developers.cloudflare.com/pages/configuration/redirects/#advanced-redirects)
