# Use the existing history API with independent read states

The first release will use the two existing history reads. Retaining that
contract lets the owner open details independently of the list and continue
browsing when a detail read fails. Cloudflare owns the same-origin and browser
access checks and sends a separate service token to Neon. Neon owns the bounded
read over the restricted PostgreSQL projection. Angular validates responses and
owns the selected route, attention indicator, fetch times and presentation state.
The browser token stays in tab memory. The service token stays server-side.

## Contract consumed by Angular

| Read | Successful response |
| --- | --- |
| `GET /api/history` | `{ items, next }`. Accepts optional `before` from the previous page and `limit` from 1 to 50 (default 20). Orders by start time descending, then operation ID descending. A null `next` ends pagination. |
| `GET /api/history/:operation` | One record for a lowercase UUIDv4. Accepts no query parameters. A missing retained record returns `404`. |

Both reads use the same record shape:

- `operation` (lowercase UUIDv4), `startedAt` and `expiresAt` (timestamp strings).
- `outcome` (`active`, `needs-reconciliation`, `succeeded` or `failed`) and
  `phase` (`bucket`, `object`, `observe`, `cleanup` or null). Null means no phase
  was recorded.
- Boolean `pendingUpload`, `cleanupRequested` and `objectRemoved`. False can
  reflect absent executor work, so it cannot establish provider state.
- Integer `used` and `limit` in each `budgets.normal`, `budgets.cleanup`,
  `budgets.monitoring` and `budgets.neon` meter. These are application counters.
- Integer `unresolved.requests` and `unresolved.mutations`, and fixed
  `verdict: "partial"`.

Reads can return newer recorded state on later requests, including after
execution expiry. The API excludes dated evidence, provider usage and remaining
allowances, and execution controls. See the [current history and dated evidence
decision](0003-project-current-history-and-preserve-dated-evidence.md) and the
[history contract](../trial/operation-history.md).

## Loading, access and recovery

| Event | UI behavior |
| --- | --- |
| First read | Show loading in the requested pane. Show **No recorded operations** only after a successful empty list response. A loading or failed detail leaves a successful list usable. |
| Temporary read or refresh failure | Offer manual retry for the affected pane. Keep its last successful result for the same list view or operation, labeled with its fetch time and a warning that it may be out of date. A fetch time describes the browser read. |
| Older-page request fails | Keep the currently visible page. Offer **Retry** for the same page request and **Go to newest** to start over. |
| Detail `404` | Show **Operation not found**, clear any prior detail for that operation and keep the list available. |
| Access denied | Clear the token and all loaded operation data and discard in-flight replies from the old access state. On `401`, keep the current URL and prompt for a valid token. On `403`, explain the site is blocked and direct the owner to the configured Berth URL. |

The panes track their results separately. The browser dispatches one history read
at a time because the Neon service admits one read per instance. On entry from
a saved link, read the detail first, then load the initial list if needed. When
a read is already dispatched, let it finish and give the latest queued detail
priority over a queued list read. A newer request for the same pane supersedes
its pending result. Any access denial for the current token clears both panes,
including when the responding read was superseded.

Refresh and retry are manual. Validate the history token locally as 32–128
characters from `A–Z`, `a–z`, `0–9`, `_` or `-` before making a request.
