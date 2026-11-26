# Hosting usage and Free-plan headroom

Infrastructure shows the hosting allowances for Berth's Cloudflare account and
Neon project and organization. Provider quotas can interrupt protected reads.
The warnings are advisory. Operation admission, request budgets, the cleanup
reserve and the historical partial/no-go verdict use their own evidence.

## Owner refresh

1. In the provider Consoles, confirm the intended Cloudflare account and Neon
   organization use the Free plans. Record Console readings from the supported
   surfaces below. Keep the collection input and Neon management API key in
   separate owner-only files (mode 600) outside the repository. Use the
   configured Berth origin and the account, organization and project IDs.
2. Build from the repository root and run the local collector. Give each refresh
   a new output filename in the owner-only directory.

   ```bash
   pnpm build
   umask 077
   node dist/scripts/hosting-usage.js \
     --input-file /absolute/private/path/hosting-readings.json \
     --neon-key-file /absolute/private/path/neon-management.key \
     > /absolute/private/path/hosting-summary.json
   ```

3. Open **Infrastructure** on the configured Berth site and connect with the
   existing Owner access token. After access is verified, choose
   **Refresh usage from summary** and select the generated summary JSON. Import
   each new summary after collecting it. Keep the input and API key files local.
   The summary contains fixed meter fields, a target fingerprint and dates.
   Berth retains imported readings in tab memory, and clears them on disconnect,
   access denial or a full reload. The import uses the browser's file picker and
   makes no network request.

The collector sends one GET to Neon's project detail endpoint with a five-second
deadline and a 64 KiB response limit. It checks the project and organization
IDs and the returned billing-period boundaries. Neon documents
`compute_time_seconds` as the weighted CU-seconds field on the Free project
snapshot. The collector also accepts `compute_unit_seconds` and requires the
values to agree when both appear. It divides by 3,600 before threshold evaluation.
Neon describes the project snapshot as approximate and intended for monitoring.
The project's metadata update timestamp does not establish how far usage data
has arrived. If the request fails and the same input supplies a qualified
project Console reading, the collector includes that reading. To use the Console
source alone, omit `--neon-key-file`.
[Neon project details](https://neon.com/docs/reference/api/projects/get-project) ·
[Neon Free usage fields](https://neon.com/docs/introduction/usage-calculations#tracking-usage-on-the-free-plan)

## Console readings

Use timestamp strings in UTC with milliseconds, such as
`2026-11-26T14:30:00.000Z`. Supply `dataThrough` when the provider displays
it. Use the meter's own target ID and the units in the table. For Neon compute,
enter the start and end of the displayed billing period. Berth derives the
Cloudflare UTC day from `observedAt`. Neon storage is a continuous limit.

| Meter key | Accepted Console surface | Target | Unit |
| --- | --- | --- | --- |
| `cloudflare-requests` | Workers & Pages → Overview → Requests today | Cloudflare account | `requests` |
| `neon-compute` | Project Overview → Usage → Compute | Neon project | `CU-hours` |
| `neon-project-storage` | Project Overview → Usage → Storage | Neon project | `GB` |
| `neon-organization-storage` | Organization Projects → Usage → Storage | Neon organization | `GB` |

Cloudflare counts account-wide Workers and Pages Function invocations, including
denied application requests that invoked a Function. Static assets that skip
Functions are excluded. Per-script analytics, Berth logs and Observability event
counts do not establish this quota. Neon Console usage can lag about an hour
and stop updating for inactive projects.
[Cloudflare request accounting](https://developers.cloudflare.com/pages/functions/pricing/) ·
[Neon Console usage](https://neon.com/docs/introduction/monitor-usage) ·
[Neon Free allowances](https://neon.com/docs/introduction/plans)

Use `precision: "exact"` for a complete meter total at its original precision,
including a confirmed zero. For a documented upper bound, enter the conservative
maximum as the `value` with `precision: "upper-bound"`. Preserve its basis in
your local evidence. For example, if the provider documents truncation to the
nearest 0.1 GB and reports 0.8 GB, a bound of 0.9 GB covers the display.
Use `precision: "rounded"` when display rounding lacks an established bound.
For storage, confirm the display represents current Postgres storage for the
whole project or organization. Use no numeric headroom when the display
represents a branch, average, GB-months or ambiguous units.

Sample synthetic input with Cloudflare and organization storage readings:

```json
{
  "origin": "https://berth.example",
  "target": {
    "cloudflareAccount": "fixture-account",
    "neonOrganization": "org-fixture-01",
    "neonProject": "fixture-project-01"
  },
  "metrics": {
    "cloudflare-requests": {
      "source": "cloudflare-account-console",
      "target": "fixture-account",
      "unit": "requests",
      "value": 0,
      "precision": "exact",
      "observedAt": "2026-11-26T14:30:00.000Z"
    },
    "neon-organization-storage": {
      "source": "neon-organization-console",
      "target": "org-fixture-01",
      "unit": "GB",
      "value": 4.2,
      "precision": "upper-bound",
      "observedAt": "2026-11-26T14:30:00.000Z"
    }
  }
}
```

The other source code is `neon-project-console`, shared by the two project
Console inputs. For example, a `neon-compute` Console reading must include
`"period": { "start": "2026-11-01T00:00:00.000Z", "end": "2026-12-01T00:00:00.000Z" }`
if those are the provider's dates. Omit a meter if you did not refresh it.
Supply `null` for a meter whose Console reading you attempted to obtain but
could not qualify. Import a summary after an unsuccessful Neon request to see
that attempt reflected as **Stale** for any retained compute value. Select
**Disconnect** before intentionally starting a different hosting target at the
same origin.

## Reading the panel

- Current readings show the remaining allowance and text warnings at 80%, 95%
  and 100%. Bound-based warnings apply to the conservative upper bound.
- A previous reading becomes **Stale** after two hours, at the end of its quota
  period or when its refresh fails. Its value and dates remain visible. A fresh
  successful reading for that meter restores its headroom.
- Shared Neon public network transfer remains **Unknown** without a total or
  defensible bound covering Postgres, Object Storage and Functions together.
  Branch transfer, the proxy counter and rounded organization figures cannot
  establish that total.
- The three Neon Functions meters remain **Unknown** because the verified Free
  surfaces do not provide project billing-period totals. Deployment lists and
  recent invocation logs cannot establish the totals.
  [Neon Consumption History availability](https://neon.com/docs/reference/api/consumption/get-consumption-history-per-project-v2)

Local verification uses fixture responses and a controlled clock. No provider
account access or deployed trial is required by the harness.
