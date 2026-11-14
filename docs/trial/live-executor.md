# Live hosted executor integration

Issues #46/#47 provide one owner-prepared operation with signed hosted admission,
real OCI continuation and cleanup. Follow [hosted-admission.md](hosted-admission.md)
for owner preparation, activation and shutdown. Local integration is not a live
feasibility verdict; #14 still requires current account evidence and a live run.

## Build and ownership

- Run `pnpm run build:live-executor` with the pinned toolchain.
- Output: `dist/live-executor.zip`, plus byte count and SHA-256 on stdout.
- Descriptor: `liveFunction` in `neon.ts`, source `src/trial/live-index.ts`.
- `liveSchedule` uses `/scheduled` every 15 minutes and defaults to disabled.
- Building does not deploy a function, read private credential files, enable a
  schedule, install SQL or contact OCI.
- The synthetic `executorFunction` remains isolated and rejects OCI credentials.

The handler authenticates controls or validates the Neon gateway schedule envelope
before parsing the signing key or connecting to SQL. The existing gateway
prerequisite still applies: caller-supplied invocation headers must be stripped.
This application cannot prove gateway origin from a header alone.

Each accepted invocation opens one bounded restricted connection. It checks actual
SQL privileges, then compares the persisted operation, namespace, compartment,
region and exact start/expiry timestamps with deployment configuration. A mismatch
stops before claiming execution or contacting OCI. SQL remains authoritative for
leases, request budgets, attempts, deduplication and cleanup deadlines. The
connection stays open until the executor settles, including uncertain outcomes.

## Deployment inputs (server-side secrets/configuration only)

These are the exact environment names consumed by the new root. Keep their values
outside Git, chat, shell arguments and logs. Use the owner prepare function in the runbook; do not bypass admission by manually inserting a trial row.

| Input | Required value |
| --- | --- |
| `DATABASE_URL`, `DATABASE_URL_UNPOOLED` | Restricted `berth_runtime` login to `neondb` on Neon, both owner URLs overridden; runtime enforces TLS `verify-full` |
| `PGPASSWORD` | Unset, the existing disabling marker, or the restricted URL password; never an owner password |
| `BERTH_EXECUTOR_MODE` | Exactly `live` |
| `BERTH_EXECUTOR_OPERATION` | The admitted version-4 operation UUID |
| `BERTH_EXECUTOR_STARTED_AT`, `BERTH_EXECUTOR_EXPIRES_AT` | Unix milliseconds copied from authoritative SQL timestamps; exactly four hours apart |
| `BERTH_PREVIEW_KEY` | Independent 32–128-character URL-safe preview-signing secret |
| `BERTH_MONITORING_LIMIT`, `BERTH_NEON_LIMIT` | Match prepared SQL binding; Neon minimum 40, both at most 1000 |
| `BERTH_TRIAL_TOKEN` | Private 32–128-character token using letters, digits, `_` and `-` |
| `OCI_TENANCY_OCID`, `OCI_USER_OCID` | Dedicated trial identity's tenancy and user; not the administrator user |
| `OCI_PRIVATE_KEY` | Trial RSA private PEM contents (not a file path or public key); unencrypted, at least 2048 bits, at most 8192 characters |
| `OCI_FINGERPRINT` | Matching lowercase colon-separated public-key fingerprint |
| `OCI_COMPARTMENT_OCID`, `OCI_NAMESPACE`, `OCI_REGION` | Exactly the admitted dedicated trial target |

Remove `NEON_API_KEY` and every other `OCI_*` value. Injected AWS access/secret keys
and the Neon AI gateway token must be absent or set to the existing
`disabled-for-berth-probe` marker. The shared SQL guard rejects database/schema
ownership, role memberships, broad role flags, CREATE/TEMP and direct protected
ledger/executor/usage table privileges. Install migrations 001–004 separately as
owner; the runtime cannot install them.

The local fingerprint check follows Oracle's
[API signing-key fingerprint definition](https://docs.oracle.com/en-us/iaas/Content/API/Concepts/apisigningkey.htm).
It proves a key/fingerprint match, **not** key registration, effective IAM grants,
free-plan eligibility or current allowance headroom. Those remain required owner
checks before activation. No administrator config file is read by this runtime.

## Routes and evidence

All routes require POST, no query string, and a live deployment window.

- `/scheduled`: authenticated Neon gateway schedule envelope only; a manual bearer
  token is insufficient. One delivery calls up to two real fenced steps under one shared 50-second deadline.
- `/evidence`: bearer-authenticated, empty body. Returns fixed-operation phase,
  terminal status, redacted reason, removal flag and SQL timestamps.
- `/usage`: bearer-authenticated, empty body. Returns stored normalized observations
  and warnings; it does not make an on-demand Monitoring call.
- `/cleanup`: bearer-authenticated, empty body. Sets the durable cleanup flag for
  this operation. A later scheduled execution performs conditional teardown.
  Creation headroom is not rechecked to admit cleanup.
- `/preview` and `/submit`: bearer-authenticated bounded JSON API, `{}` and
  `{"preview":"SIGNED_VALUE"}` respectively. Preview persists metered credential
  evidence; submit opens the prepared SQL gate. Neither directly creates OCI resources.
  There is no manual execute route or caller-selected operation/target.

Expired requests return before credentials/SQL work. Control responses use
`Cache-Control: no-store`; unexpected errors have fixed redacted diagnostics.
A cleanup receipt is not deletion evidence. Terminal success, authenticated
absence and no unresolved requests must still be demonstrated in #14.

The real transports sign locally and send once, without automatic retries. The
executor reserves each Object Storage and Monitoring request through existing
meters. Limits remain 160 normal + 40 cleanup Object Storage requests, separately
configured Monitoring/Neon limits and three action attempts. Creation stops after
30 minutes; cleanup begins by hour three; the window expires at hour four.
Application limits cannot cap provider billing or all externally triggered
function invocations. No paid plan or hard spending cap is implied.

## Verification and remaining gates

Local tests cover authentication-before-I/O, expiry, key/fingerprint validation,
SQL privilege rejection, exact target/window matching, delayed executor completion
before SQL close, signed transport composition and fail-closed creation deadlines.
Harness fixtures allow only reviewed module edges and reject administrator and
synthetic coupling. Existing executor/SQL suites own phase, budget and recovery
semantics. Migration 004 adds admission and invocation-reserve gates while
preserving the existing Object Storage limits.

The #47 runbook provides admission, metered credential checks, configuration
handoff, cadence assumptions, interruption and shutdown procedures. Fresh
account/headroom evidence, actual deployed IAM/DB permissions, live metrics/warnings,
computer-offline continuation and real teardown remain unverified locally.
No cloud resources were deployed for either integration issue.
