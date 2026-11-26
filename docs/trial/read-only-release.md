# Read-only Free-plan release and rollback

Scope: the Angular Infrastructure and Operation history screens, two Pages
read routes, and two dedicated Neon Functions. The release reads retained SQL
evidence. It requires no OCI credentials, provisioning, cleanup requests,
execution Function, Retry endpoint or schedules. Approval for this release
cannot authorize a lifecycle trial.

See the [dated qualification](read-only-release-120.md) for the current decision.

## Decide whether to release

Record a dated snapshot for the specific production Cloudflare account and Neon
organization, project and branch. Record the source, meter scope, period, value
and unit, applicable Free limit, defensible remaining capacity, and a release
envelope that fits within it. Keep raw account data privately and publish only
redacted evidence references.

| Evidence | Where to check |
| --- | --- |
| Workers Free status and request headroom | In Cloudflare, select the account and open **Workers & Pages → Plans**. Confirm **Free → Current plan**. In the Workers & Pages account overview, inspect the account-wide request meter for the current UTC day. If only per-project **Metrics** are available, record that limitation and obtain an account-wide reading or complete same-period coverage before counting remaining requests. |
| Neon Free plan and billing exposure | In Neon, choose the organization and open **Billing**. Confirm **Current plan → Free** and verify that the release leaves billing and upgrades unchanged, with no paid fallback. The management API can independently confirm the plan. Date the official $0 and Free-limit billing evidence for the products in use. No-card status alone cannot establish that basis. |
| Neon Postgres and shared transfer headroom | Open the target project **Overview → Usage**. Record the reported scope and period and the raw compute, storage, history and network transfer counters with units. Use the applicable per-project compute and storage limits, aggregate organization storage limit, and the per-project public transfer limit shared by Postgres, Object Storage and Functions. Use an aggregate reading or reconcile all contributing sources before accepting a remaining value. Never subtract an incomplete or differently scoped counter from a shared limit. |
| Neon Functions usage | Check **Overview → Usage** or an eligible consumption API for provider totals for invocations and active and waiting capacity. Record units, period and coverage. When a meter is unavailable, name the dated Console/API surface and record usage and remaining capacity as **unknown**. Postgres counters and Function invocation logs cannot supply those totals. |
| Release and rollback targets | Record the two intended read Function names, the canonical Pages origin, the retained successful production deployment available for rollback (if any), and the owner's independent access to disable both upstreams. List every active alias and preview to verify during shutdown. |

Pages Function requests count against the Workers Free account-wide quota of
100,000 requests per day, resetting at midnight UTC. Requests denied by the
proxy can still consume it. Each accepted read makes at most one upstream
request, with a four-second deadline and a 128 KiB response cap. Record planned
smoke-test and rollback requests plus expected normal and concurrent usage.
Compare observed usage to the envelope before approval and after the smoke test.
Warn and suspend continued reads while there is still room for shutdown
verification if the remaining headroom no longer covers the envelope.
[Pages pricing](https://developers.cloudflare.com/pages/functions/pricing/) ·
[Workers limits](https://developers.cloudflare.com/workers/platform/limits/)

Apply the reviewed [Free-plan policy](../../SPEC.md#revised-functions-evidence-policy--issue-68-2026-11-19) to this read-only
scope. Unknown **Functions** usage can be accepted only with current Free plan
and billing evidence, adequate known headroom for the other applicable meters,
and the owner's explicit acceptance of possible quota interruption for the
proposed release. The trial's [one-operation exception](bounded-allowance-exception.md)
stays untouched. Missing or insufficient headroom for a required known meter,
provider-reported Functions exhaustion or insufficiency, unverifiable Free
billing terms, a paid fallback, or unresolved shutdown access means **no-go**. A quota stop can
make protected reads unavailable. The UI can show an availability warning and
keep its last successful result in tab memory. Use no automatic retries or paid
fallback. These bounds provide no hard cross-provider spending cap.
[Neon plans](https://neon.com/docs/introduction/plans) ·
[Neon Free limits FAQ](https://github.com/neondatabase/website/blob/main/content/faqs/free-plan-limits-and-quotas.md) ·
[Neon consumption metrics](https://neon.com/docs/guides/consumption-metrics)

Obtain separate owner approval of the exact candidate commit and artifacts,
targets, allowance snapshot, residual interruption risk, and release/shutdown
plan before changing either host or applying any database migration. If no
prior successful production deployment exists, approve access shutdown as
the first-release fallback.

## Prepare the candidate

1. Confirm the dedicated database and applied migration history on the intended
   branch. History needs migration `008_operation_history.sql` and its documented
   prerequisites. Inventory needs the retained ledger and Inventory migrations
   `009_managed_inventory.sql` and `010_inventory_evidence.sql`. Install any
   missing prerequisites in dependency order as the dedicated owner after approval.
   Preserve existing records. Use the
   [History installation guide](operation-history.md#install-and-consume) and the
   [Inventory role and migration guide](managed-inventory-api.md#bindings-and-database-access).
   Migration 011 and the Retry runtime are outside this release.
2. Build from the repository root with `pnpm ui:install`, `pnpm check` and
   `pnpm build:inventory`. Check `dist/history.zip` and `dist/inventory.zip` and
   record their SHA-256 hashes alongside the candidate commit. The UI gate runs
   `pnpm build:ui:read-only` and tests the resulting package. Keep the generated
   `ui/dist/read-only` Pages root intact and retain a digest manifest of its
   `browser/`, `functions/` and `edge/` directories. The browser files include
   the generated CSP `_headers`, saved-link `_redirects`, and read-only
   `_routes.json`. The Functions directory contains only the History and Inventory
   handlers. Record the Wrangler version used to compile the Pages Functions and
   verify the local artifact and bindings before approving upload.
3. Prepare the binding maps for two dedicated Neon read Functions without
   triggers. On History use
   only the restricted `berth_runtime` credentials in **both** `DATABASE_URL` and
   `DATABASE_URL_UNPOOLED`. On Inventory use `berth_inventory_runtime` and set
   both default URLs and `BERTH_INVENTORY_DATABASE_URL` to the same restricted
   connection. Use `BERTH_HISTORY_TOKEN` and `BERTH_INVENTORY_TOKEN` for distinct
   service credentials. Keep owner credentials out of every deployed binding.
   [Neon Function environment variables](https://neon.com/docs/compute/functions/environment-variables)
4. Complete the automated and desktop screen-reader checks for the exact
   candidate and record the results with the release evidence before requesting
   upload approval. Follow the
   [History accessibility qualification](../../ui/README.md#history-accessibility-qualification).

From the staged Pages root, compile the Functions with the Wrangler version
recorded for the candidate. The example uses the version used for local
qualification.

```bash
cd ui/dist/read-only
scratch=$(mktemp -d)
pnpm dlx wrangler@4.168.0 pages functions build functions \
  --outdir "$scratch/worker" --output-routes-path "$scratch/routes.json" \
  --compatibility-date 2024-11-11
```

The compiled route inventory should include `/api/history`,
`/api/history/*`, `/api/inventory` and `/api/inventory/*`. Use
`pnpm dlx wrangler@4.168.0 pages dev ./browser --compatibility-date 2024-11-11`
from the same directory to check static assets, security headers, saved links and
404 routing over loopback HTTP. Successful protected reads require the canonical
HTTPS origin and an upstream response. To exercise reads with the compiled Worker
locally, supply a synthetic canonical HTTPS request URL and fixture bindings, and
intercept the upstream fetch with a fake transport.

The [History](../../tests/history-proxy.test.ts) and
[Inventory](../../tests/inventory-proxy.test.ts) proxy tests run the Pages
entrypoints with synthetic HTTPS requests and fake upstream transports backed by
the Neon response handlers. `pnpm test:ui:read-only` runs the
[read-only browser tests](../../ui/tests/read-only.spec.ts) against the staged
browser output with intercepted History and Inventory responses. The
[History accessibility checks](../../ui/README.md#history-accessibility-qualification)
use the same candidate and CSP.

History enters a read-only transaction and calls only the bounded History page
and detail projections. Its `berth_runtime` login still has retained executor
grants at the database layer. Treat this as an explicit residual risk for the
release decision. Never reuse that login for Inventory. Inventory assumes
`berth_inventory_reader` within a read-only transaction after checking the login
and grants. The Inventory login and reader have no authority to mutate records
or call the executor. Verify actual privileges on the target branch and retain
redacted results before opening owner access.

## Publish after separate approval

1. Recheck the recorded digests. Through the targeted Neon Function deploy API,
   upload `dist/history.zip` to the approved History slug and
   `dist/inventory.zip` to the approved Inventory slug on the same approved branch.
   Send each ZIP as the multipart `zip` field, `nodejs24` as `runtime`, and the
   corresponding allowlisted binding map as the JSON `environment` field. Load
   credentials privately and keep them out of shell arguments and logs. Confirm
   both deployment IDs are active before using their invocation origins.
   [Neon Function deploy API](https://neon.com/docs/compute/functions/deploy#deploy-with-the-api)
2. Configure Cloudflare Pages **Settings → Runtime** with compatibility date
   **2024-11-11** or later, and select **Fail closed** for Free-plan exhaustion.
   Under **Settings → Variables and Secrets**, configure **Production** only.
   Set `BERTH_HISTORY_SITE_ORIGIN` to the exact approved HTTPS origin and
   `BERTH_HISTORY_ACCESS_TOKEN` to an independent owner browser secret. Set
   `BERTH_HISTORY_NEON_ORIGIN` and `BERTH_INVENTORY_NEON_ORIGIN` to the two
   default Neon Function origins. Set `BERTH_HISTORY_UPSTREAM_TOKEN` and
   `BERTH_INVENTORY_UPSTREAM_TOKEN` as secrets matching their respective Neon
   bindings. Leave protected preview bindings unset.
3. Use the approved artifact without rebuilding. Change into the staged Pages
   root, `ui/dist/read-only`, so Wrangler discovers its staged `functions/`.
   With the recorded Wrangler version and approved project and branch, run
   `wrangler pages deploy ./browser --project-name "$PAGES_PROJECT" --branch "$PAGES_PRODUCTION_BRANCH"`.
   Record the returned production deployment ID.
   [Pages Direct Upload](https://developers.cloudflare.com/pages/get-started/direct-upload/#functions)


## Smoke test after separate approval

- From a fresh browser, confirm the canonical root loads Infrastructure and a
  saved `/operations/:operation` link prompts for the owner token. With the valid
  token, verify Inventory, History list and a known retained History detail.
  Verify each affected offering identifies incomplete coverage and shows all
  evidence-backed rows across its pages. Confirm a complete zero-row offering
  says **No known instances** and incomplete coverage never displays that state.
  Record the missing evidence and the owner's path to reconcile it from retained
  identity-bound evidence. If the UI cannot make the distinction, stop the
  release. Confirm CSP and same-origin uncached API reads and that unsupported
  routes cannot dispatch writes.
  [Inventory coverage decision](../adr/0007-serve-managed-inventory-from-retained-evidence.md#read-only-release-readiness)
- For each Pages read route verify that a wrong token yields 401 and a foreign
  origin or unintended serving origin is denied. Verify that preview and old
  deployment URLs return no protected data. For each direct Neon URL, verify
  missing credentials, the browser token, and the other Function's service token
  yield 401. Verify each intended service token succeeds only on its own read.
  Record statuses without secrets or private response data.
- Verify the deployed bindings match the restricted login configuration, and
  check that no trigger, Retry deployment, or OCI configuration exists for this
  release. Recheck available meters and stop on unexpected activity, access
  leakage or inadequate headroom. Record the hosted results and decision with
  timestamps.

## Shut down access or roll back

1. Stop further smoke tests and record UTC time, candidate commit, deployed
   versions and the reason for stopping. Preserve dated evidence privately.
2. Cut off both upstreams first. As the authorized Neon owner, redeploy each
   dedicated read Function with a rotated service token unavailable to Pages,
   or remove the Function when retiring access. Environment values belong to
   deployments. Confirm the replacement deployment IDs are active and the old
   service tokens cannot obtain data at any formerly active invocation URL.
   If revocation cannot be verified, use the approved Function-removal fallback
   and verify the branch inventory and former URLs. Use the
   [Neon removal and inventory commands](owner-recovery.md#5-remove-hosting-and-revoke-the-dedicated-trial-key)
   for the two approved read Function names only. Leave OCI IAM and trial
   credentials out of this procedure.
3. In the Pages project open **Deployments → All deployments**. For the retained
   successful production build choose **⋯ → Rollback to this deployment**. If
   none exists, use the approved access-shutdown fallback and leave the upstreams
   closed. Revoke the old browser credential in Production; confirm Preview has
   no read bindings. Recheck the canonical domain, default Pages alias, previews
   and saved deployment URLs. Rollback only changes production's active version.
   Any remaining reachable deployment must return no protected data when shut down.
   [Pages rollbacks](https://developers.cloudflare.com/pages/configuration/rollbacks/)
4. Confirm former browser and service tokens no longer read protected data.
   Record observed status codes, configuration state, and time. Locally loaded
   data in an idle browser remains visible until that tab clears it or closes.
   When restoring owner access is authorized, bind newly generated credentials
   to the approved version and repeat the smoke test against retained evidence.
   Keep SQL migrations, records and historical verdicts in place. Do not revoke
   the shared History SQL login as part of UI shutdown.
5. Use the [independent owner cleanup procedure](owner-recovery.md) for any
   pre-existing OCI reconciliation. The read-only release does not spend or
   replenish the original 40 cleanup-only OCI requests or 12 application units.
   Preserve the historical **partial / no-go** trial verdict and the dated
   lifecycle, reconciliation and owner closeout records.
