# Live hosted executor integration

Issue #46 adds a separate Neon Functions entry point for **one already-admitted
operation**. This is local integration evidence, not a live feasibility verdict.
Do not enable it for the operational trial until #47 connects admission, accounts
for credential-check requests and supplies the reviewed deployment procedure.
Issue #14 remains blocked on that work and current account/IAM/headroom evidence.

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
outside Git, chat, shell arguments and logs. Deployment automation belongs to #47;
this table is not authorization to bypass admission by manually inserting a row.

| Input | Required value |
| --- | --- |
| `DATABASE_URL`, `DATABASE_URL_UNPOOLED` | Restricted `berth_runtime` login to `neondb` on Neon, both owner URLs overridden; runtime enforces TLS `verify-full` |
| `PGPASSWORD` | Unset, the existing disabling marker, or the restricted URL password; never an owner password |
| `BERTH_EXECUTOR_MODE` | Exactly `live` |
| `BERTH_EXECUTOR_OPERATION` | The admitted version-4 operation UUID |
| `BERTH_EXECUTOR_STARTED_AT`, `BERTH_EXECUTOR_EXPIRES_AT` | Unix milliseconds copied from authoritative SQL timestamps; exactly four hours apart |
| `BERTH_TRIAL_TOKEN` | Private 32–128-character token using letters, digits, `_` and `-` |
| `OCI_TENANCY_OCID`, `OCI_USER_OCID` | Dedicated trial identity's tenancy and user; not the administrator user |
| `OCI_PRIVATE_KEY` | Trial RSA private PEM contents (not a file path or public key); unencrypted, at least 2048 bits, at most 8192 characters |
| `OCI_FINGERPRINT` | Matching lowercase colon-separated public-key fingerprint |
| `OCI_COMPARTMENT_OCID`, `OCI_NAMESPACE`, `OCI_REGION` | Exactly the admitted dedicated trial target |

Remove `NEON_API_KEY` and every other `OCI_*` value. Injected AWS access/secret keys
and the Neon AI gateway token must be absent or set to the existing
`disabled-for-berth-probe` marker. The shared SQL guard rejects database/schema
ownership, role memberships, broad role flags, CREATE/TEMP and direct protected
ledger/executor/usage table privileges. Install migrations 001–003 separately as
owner; the runtime cannot install them.

The local fingerprint check follows Oracle's
[API signing-key fingerprint definition](https://docs.oracle.com/en-us/iaas/Content/API/Concepts/apisigningkey.htm).
It proves a key/fingerprint match, **not** key registration, effective IAM grants,
free-plan eligibility or current allowance headroom. Those remain required owner
checks before activation. No administrator config file is read by this runtime.

## Routes and evidence

All routes require POST, no query string, and a live deployment window.

- `/scheduled`: authenticated Neon gateway schedule envelope only; a manual bearer
  token is insufficient. One delivery calls the real fenced executor.
- `/evidence`: bearer-authenticated, empty body. Returns fixed-operation phase,
  terminal status, redacted reason, removal flag and SQL timestamps.
- `/usage`: bearer-authenticated, empty body. Returns stored normalized observations
  and warnings; it does not make an on-demand Monitoring call.
- `/cleanup`: bearer-authenticated, empty body. Sets the durable cleanup flag for
  this operation. A later scheduled execution performs conditional teardown.
  Creation headroom is not rechecked to admit cleanup.
- `/preview` and `/submit` are deliberately unavailable here until #47. There is
  no manual execute route or caller-selected operation/target.

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
semantics; this change does not alter their limits or migrations.

Before #14 can run, #47 must provide admission and metered credential checks,
configuration handoff, cadence/margin validation, controlled interruption and
shutdown procedures. Fresh account/headroom evidence, actual deployed IAM/DB
permissions, live metrics/warnings, computer-offline continuation and real teardown
are still unverified by this PR. No cloud resources were deployed for #46.
