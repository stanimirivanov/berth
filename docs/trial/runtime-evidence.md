# Authenticated Neon runtime experiment — issue #4

## Verdict

The pinned Alchemy engine runs the synthetic lifecycle in hosted Neon Functions on
Ohio. This establishes runtime compatibility, **not durable state or readiness for
OCI mutations**. Continue with #5 before the feasibility checkpoint #6.

The agent ran the experiment on 2026-11-13 using the owner's existing project and
private credentials. No OCI API requests, bucket/object writes, SQL schema changes,
or paid-plan changes were made. Free-plan status remains owner-attested. Provider
billing counters were delayed; a zero counter delta is not evidence of zero usage.

## Implementation and boundaries

- `src/trial/synthetic-lifecycle.ts` uses the real Alchemy `Plan.make`, `apply`,
  second plan/read, and `Plan.destroy` APIs with a memory-only provider. Each call
  gets isolated in-memory Alchemy state, then checks that destruction emptied it.
- `src/trial/index.ts` loads the pinned OCI Object Storage client, generates an
  ephemeral RSA key, signs a synthetic request, and verifies its signature locally.
  It never sends that request and needs no OCI credentials.
- Each successful manual lifecycle call opens one restricted Postgres connection
  and runs one `current_user` check. Both injected database URLs must name
  `berth_runtime` in `neondb`; the actual login must confirm that role.
- `deploymentEnvironment` copies only approved runtime values. Deployment API keys
  are not copied. Unused automatically injected AI Gateway and S3 credentials are
  overridden with the nonsecret value `disabled-for-berth-probe`. Empty values would
  remove an override and could restore the injected default.
- Bearer authentication precedes protected work. Inputs cannot select providers,
  targets, durations or actions. Nonempty manual bodies and query parameters fail.
- A deployment expires within 20 minutes. After expiry manual requests return 410;
  scheduler requests acknowledge with 200 without doing work, stopping retries.
- `/scheduled` performs no Alchemy, database or cloud operation. It validates the
  Neon delivery envelope and edge-provided header, retains at most eight hashed
  occurrence IDs, requests one retry with 503/`Retry-After: 1`, and returns 200 for
  a repeated ID. This memory-only observation is **not durable deduplication**.
- `/timeout` is authenticated and fixed: cancel a one-second timer after 25 ms.
  This tests cooperative cancellation, not interruption of a remote mutation.
- Lifecycle execution has a five-second Effect timeout; DB connect/query limits
  are five seconds each. A timeout does not imply cancellation of a remote write.

## Versions and packaging

| Component | Version / observation |
|---|---|
| Local Node / pnpm | 24.22.3 / 12.16.1 |
| Observed hosted Node | 24.22.1; Neon selects the patch for `nodejs24` |
| Alchemy / Effect | 2.0.0-beta.86 / 4.1.4 |
| OCI common / Object Storage | 2.146.0 / 2.146.0 |
| Official Neon bundler | `@neon/config-runtime` 1.12.3 |
| Final ZIP | 378,597 bytes |
| Final ZIP SHA-256 | `b81693791c6533f5a7feea3cfe8ee5cb9795327cac672ba3fbfe9ce3bad9d94f` |
| Scheduler-tested pre-format ZIP SHA-256 | `b6fd719a60adbf4bfbbf5985a2ebb1e12b914371fda14963b5cc7dbb0a6794bf` |

The official bundler supplies ESM/CommonJS interoperability. Alchemy imports optional
Bun and terminal-development packages that are not installed. The descriptor marks
`@effect/platform-bun` and `react-devtools-core` external without shipping files.
They are not used by this Node-only headless path. All dependencies exercised by
this probe are bundled. This does not prove other Alchemy CLI/UI or Bun paths work.

## Deployed observations

| Check | Observation |
|---|---|
| Missing / invalid bearer | 401; protected lifecycle not invoked |
| Valid bearer | 200; create/read/delete/state-empty all true |
| Restricted DB role | Actual login check passed |
| OCI SDK signing | Local signature verification passed |
| Forged scheduler header and envelope | 401 through Neon's public gateway |
| Initial successful instance call | 1,422 ms client time; 858 ms handler work; RSS 92,295,168 bytes |
| Subsequent call, same boot ID | 410 ms client time; 113 ms handler work; RSS 88,571,904 bytes |
| Fixed timeout experiment | 504; timer cancelled after 26 ms; 197 ms client time |
| Genuine scheduled occurrence | 2026-11-13 10:27:00 UTC; two deliveries sharing the same hashed ID |
| Trigger after observation | Explicitly disabled; GET confirmed `enabled: false` |
| Residual observation after disable | Same one occurrence and two deliveries; no new receipt before removal |
| First cleanup | 10:28:33 UTC; function and trigger inventories both empty |

The two successful lifecycle calls have distinct HTTP invocations and independent
in-memory state. A final ZIP deployment additionally checks a fresh instance after
removal; its result is recorded below. Cross-invocation durable create/read/delete
is deliberately left to #5.

The initial-call versus warm-call timings include database wake-up, transport and
scheduling effects; they do not isolate platform cold-start overhead. Neon's
15-minute first-byte limit is documented, not exercised by this short experiment.
No cancellation guarantee for in-flight provider mutations is inferred.

Deployment propagation was observable: the management API could report the new
revision completed while requests still returned prior behavior. Compare the
**response build digest**, not merely deployment status, before accepting evidence.
The initial body guard also rejected empty request streams; a failing regression
test established the fix before redeployment.

## Usage and secret evidence

The first run's private journal recorded 27 management requests and 22 journaled
manual function requests, including debugging failures, six deployments, two
successful lifecycle calls, and 1,406 response-body bytes. One additional direct
HTTP diagnostic request was not included in that journal count. The real scheduler
added two observed deliveries. Management response/upload bytes, headers, TLS and
platform retries are not included in the response-body measurement.

- The two successful lifecycle calls issued two read-only SQL queries. Rejected
  credential checks stopped before DB access. Scheduled deliveries issued none.
- Before/after project counters: `cpu_used_sec` 0 → 0,
  `data_transfer_bytes` 3,707 → 3,707, `data_storage_bytes_hour` 0 → 0.
  These are delayed, project-wide counters, not attributable billed consumption.
- A bounded log query returned 100 records, not truncated, including 32 Alchemy
  event records. An exact-value scan found none of the private trial token,
  restricted password or database URLs. No raw logs or connection strings are
  committed. The synthetic provider state contains only a fixed nonsecret marker.
- Schedules can leave queued deliveries after disabling. Expiry suppresses work,
  but requests can still consume quota. Deletion and empty inventory checks are
  therefore required; expiry is not a hard spending cap.

Private run records are under `$HOME/.config/berth-trial/neon-probe-issue-4-01/`,
mode 0700 with 0600 files. Keep the journal for reconciliation. No credentials need
to be pasted into chat or GitHub.

## Reproduce locally

Run from the repository with its pinned Node and pnpm versions:

```bash
pnpm install --frozen-lockfile
pnpm run test:runtime-probe
pnpm run build:runtime-probe
pnpm run typecheck
pnpm run lint
pnpm test
```

`build:runtime-probe` writes `dist/runtime-probe.zip` and prints its size and digest.
`neon.ts` is a descriptor for this build command, not a generic `neon deploy`
configuration. Building does not read credentials or contact Neon.

## Reproduce the hosted experiment

This is an operator-controlled feasibility probe, not a general deployment CLI.
Use a fresh private run directory and record an intent before every management
write. Never retry an uncertain write or adopt an existing same-name function.
The experiment used Node's built-in `fetch`, the pinned official bundle builder,
and the repository's owner-only private-file reader; no credentials appeared in
command-line arguments.

1. Read `neon-runtime.json` and `neon-api-key` with
   `dist/scripts/oci-files.js` → `readPrivateText`. Use the runtime file's
   `target.project` and `target.branch`; require Ohio and current Free headroom.
2. GET `/projects/{project}/branches/{branch}/functions` and `/triggers` on
   `https://console.neon.tech/api/v2`. Require empty inventories for this trial.
3. Build the ZIP. Call `deploymentEnvironment(runtime, sha256, Date.now() +
   20 * 60000)` from `dist/src/trial/deployment.js`. Do not copy the rest of
   `process.env` or put the management API key in this map.
4. POST `/projects/{project}/branches/{branch}/functions/berthprobe4/deployments`
   with the API key in the management Authorization header. Multipart fields:
   - `zip`: the ZIP bytes, filename `bundle.zip`.
   - `runtime`: `nodejs24`.
   - `environment`: JSON serialization of the allowlisted environment map.
   Save the response privately. Do not print environment responses.
5. GET the function until the returned deployment ID matches and is completed.
   Bound polling to three minutes and each request to 20 seconds; never replay
   the POST automatically. Read `function.invocation_url` from the response.
6. POST the invocation URL with no body: missing and invalid bearer must give
   401; the private `BERTH_TRIAL_TOKEN` must give 200. Require the response digest
   to match the uploaded ZIP. Repeat once; compare boot IDs and lifecycle results.
   POST `/timeout` with the valid token: require 504 and `timerAborted: true`.
7. POST `/scheduled` from the public client with a forged
   `X-Neon-Trigger-Invocation-Id` and matching envelope: require 401. Directly
   exposing this handler outside Neon's stripping gateway is unsupported.
8. POST `/triggers` with this fixed body, then save `trigger.trigger_id` privately:

   ```json
   {
     "type": "schedule",
     "name": "berth-probe-retry",
     "function_slug": "berthprobe4",
     "function_path": "/scheduled",
     "enabled": true,
     "schedule": { "cron": "* * * * *" }
   }
   ```

9. For at most two minutes, POST `/evidence` with the valid bearer, at most once
   every ten seconds. Require one hashed ID with two deliveries. Receipts may be
   incomplete if requests reach different instances; do not call this durability.
10. PATCH `/triggers/{recorded-trigger-id}` with
    `{"type":"schedule","enabled":false}` regardless of whether the receipt
    test passed. GET to confirm. Observe for one further minute to catch queued
    deliveries. Save request counts, latency, SQL-query counts and byte totals.
11. Read project consumption counters and query branch logs using
    `/logs/query`, with a bounded time range, service name `neon-function/berthprobe4`
    and limit 1000. Save privately; scan for secret values without displaying them.
12. DELETE only the recorded trigger and owned `berthprobe4` function, then GET
    both inventories. Require zero trial resources. If a request fails or the
    process stops, reconcile the private journal and remove recorded resources
    before starting another run. Do not retry by changing the slug.

## Official references checked 2026-11-13

- [Function handler and supported regions](https://neon.com/docs/compute/functions/overview)
- [Deployment API and bundling](https://neon.com/docs/compute/functions/deploy)
- [Injected environment variables and overrides](https://neon.com/docs/compute/functions/environment-variables)
- [Authentication](https://neon.com/docs/compute/functions/authentication)
- [Trigger attestation and delivery identity](https://neon.com/docs/compute/functions/triggers/overview)
- [Schedules and disabling](https://neon.com/docs/compute/functions/triggers/schedule)
- [Runtime limits](https://neon.com/docs/compute/functions/reference/runtime-limits)

## Exact final artifact confirmation

At 10:31 UTC, a fresh function instance returned the **final ZIP digest above**,
Node 24.22.1, invocation number 1, and a different boot ID from the earlier run.
Create/read/delete/state-empty, restricted DB login and local OCI signature checks
all passed again. Client time was 2,252 ms; handler time 1,547 ms; RSS 86,556,672
bytes. This added one read-only SQL query and 392 response-body bytes.

The final confirmation recreated no schedule. Cleanup at **10:31:47 UTC** again
verified **zero functions and zero triggers**. Across both journaled runs: 32
management requests, 23 manual function requests, seven ZIP deployments, three
successful lifecycles and 1,798 manual response-body bytes. The additional direct
diagnostic request and two observed scheduler deliveries remain separate from
those journaled manual totals. Billing-unit attribution remains inconclusive.

## Repository verification

- `pnpm test`: passed all eight test files, including eight new probe cases.
- `pnpm run typecheck`, `pnpm run lint`, and `pnpm run build:runtime-probe`: passed.
- TDD included failing tests before the handler, environment allowlist, empty-stream
  fix, controlled error stages and timeout experiment were implemented.
- Review mutation: inverting the bearer comparison made the focused suite fail;
  restoring the exact source made it pass again.
- Read-only cross-model review found no actionable issue within this probe's scope.
- `pnpm audit`: zero critical/high, seven moderate and one low advisory. These are
  existing lockfile packages (`@hono/node-server`, `glob`, `minimatch`, `diff`), not
  newly resolved dependencies. The new direct bundler entry reuses the version
  already installed transitively by Neon CLI. The probe exposes no Hono server,
  static-file handler, WebSocket upgrade, patch parser or caller-selected glob.
  This is not a clean dependency audit; review these advisories before broadening
  the runtime's exposed capabilities.
