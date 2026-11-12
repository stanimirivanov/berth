# Neon setup script

This is the Neon portion of issue #3. It configures an existing, dedicated Free
project; it does not create OCI resources, deploy Functions, or enable schedules.
Ohio (`aws-us-east-2`) is supported. Account readiness remains pending until the
owner runs the script and completes the console/deployment checks below.

## Prerequisites

- Use the pinned Node/pnpm versions from `.nvmrc` and `package.json`, then `pnpm install --frozen-lockfile`.
- Run commands from the berth repository root on Linux/macOS.
- Confirm **Free**, current allowance headroom, and Functions availability in the
  Neon Console. `--confirm-free-plan` records your attestation; the script cannot
  verify the billing plan from the project metadata response. It never upgrades
  a plan or enables another service.
- Use exactly one branch and one read-write endpoint, with scale-to-zero at five
  minutes or less. The API value `0` means the default five minutes.
- Copy the **project ID** and **branch ID** from the Console; these are IDs, not
  their display names. Check the database and owner names in the Connect dialog;
  the defaults below are `neondb` and `neondb_owner`.
- Create a Neon API key with access to this project. Choose the narrowest project
  scope available. This key is an owner/deployment credential, never a runtime
  secret. Revoke a temporary setup key after verification.

The database must be fresh: no existing application tables, views, sequences or
functions, no other application databases on the branch, and no existing role or
schema with the requested names. Extension-owned objects are excluded from the
freshness check. Do not enable integrations that add application schemas before
running this bootstrap.

## Store the API key privately

Create an owner-only directory outside the repository. This example prompts for
the key without echoing it or putting it in command history/process arguments:

```bash
python3 - <<'PY'
from getpass import getpass
from pathlib import Path
import os

directory = Path.home() / '.config' / 'berth-trial'
directory.mkdir(parents=True, mode=0o700, exist_ok=True)
directory.chmod(0o700)
key = getpass('Neon API key (hidden): ').strip()
if not key:
    raise SystemExit('No key supplied')
fd = os.open(directory / 'neon-api-key', os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, 'w') as file:
    file.write(key + '\n')
PY
```

The command refuses to overwrite an existing key file. Do not paste keys,
connection strings, generated credentials, or private JSON files into chat or
GitHub. Keep terminal tracing (`set -x`) disabled.

## Preview, apply, verify

Set only nonsecret IDs in these shell variables:

```bash
BERTH_PROJECT_ID='your-project-id'
BERTH_BRANCH_ID='br-your-branch-id'
BERTH_PRIVATE_DIR="$HOME/.config/berth-trial"

pnpm run setup:neon \
  --project "$BERTH_PROJECT_ID" --branch "$BERTH_BRANCH_ID" \
  --region aws-us-east-2 \
  --api-key-file "$BERTH_PRIVATE_DIR/neon-api-key" \
  --confirm-free-plan --mode plan
```

`plan` makes three metadata GET requests. It validates project/region, branch,
endpoint and suspension settings and prints the intended changes. It does not
fetch a database credential or connect to Postgres. Database freshness is checked
transactionally during `apply`.

```bash
pnpm run setup:neon \
  --project "$BERTH_PROJECT_ID" --branch "$BERTH_BRANCH_ID" \
  --region aws-us-east-2 \
  --api-key-file "$BERTH_PRIVATE_DIR/neon-api-key" \
  --secrets-dir "$BERTH_PRIVATE_DIR" \
  --confirm-free-plan --mode apply
```

Optional overrides are `--database`, `--owner`, `--role`, and `--schema`. Runtime
role and schema names must start with `berth_`. Keep the same arguments for all
three modes.

Apply retrieves the selected owner's direct connection URI privately, verifies
the endpoint and TLS certificate, and creates:

- A SQL-created login role `berth_runtime`, with no role memberships, ownership,
  DDL, database creation, role administration, replication or RLS bypass rights.
- Owner-held schema `berth_trial`; the runtime receives only schema `USAGE`.
- Two empty owner-held verification tables. Runtime CRUD is allowed only on
  `permission_probe`; `denied_probe` remains inaccessible.

Apply also revokes **PUBLIC database CREATE/TEMP** and **PUBLIC public-schema
CREATE**. These changes affect all ordinary roles in this dedicated database,
which is why using an existing application database is refused. Database changes
are transactional. Future trial tables and sequence permissions belong to their
own migrations; this bootstrap grants no blanket future-table access.

Generated credentials are written exclusively to `neon-runtime.json` in the
private directory with mode `0600`, before database mutation. This file contains
the runtime password, both restricted database URLs, and a random trial bearer
token. It contains no owner password or Neon API key. Both URLs initially use
the same direct endpoint, suitable for the small trial; pooling is a later
deployment choice. Values are never printed.

```bash
pnpm run setup:neon \
  --project "$BERTH_PROJECT_ID" --branch "$BERTH_BRANCH_ID" \
  --region aws-us-east-2 \
  --api-key-file "$BERTH_PRIVATE_DIR/neon-api-key" \
  --secrets-dir "$BERTH_PRIVATE_DIR" \
  --confirm-free-plan --mode verify
```

Apply automatically runs the same verification. Separate `verify` reruns it
without changing the role, password or grants. It checks actual runtime login,
effective grants and memberships, transactional CRUD, and expected SQLSTATE
`42501` denials for table/schema/temp-table creation, role creation, altering an
owner table, reading the denied table, and assuming the owner role. Verification
rolls back its probe transaction even if an operation unexpectedly succeeds.

## Failures and recovery

No automatic retries, role adoption, password resets, or cleanup are performed.
An existing output file or role/schema makes apply stop. Do not delete the
private file and blindly rerun apply: a lost connection during COMMIT can leave
the database configured even though the command failed. Retain credentials and
run verify first. If it fails, inspect the selected database as owner; reconcile
the exact role/schema before retrying. Share only redacted status when asking
for help. Provider errors are intentionally not printed because they may contain
SQL or secrets.

Each request/connection/query has a timeout; the command can wake the database
and consume its Free allowance. API queries are bounded and no scheduler is
started. This is not a spending cap.

## Remaining owner checks

- Record dated Free-plan and allowance evidence in the readiness checklist.
- Confirm Functions and scheduled triggers are available, leaving schedules off.
- At the later deployment step, use the private runtime values to override
  **both** injected `DATABASE_URL` and `DATABASE_URL_UNPOOLED`. Verify there is no
  alternate injected owner connection or deployment API key reachable at runtime.
  This script does not deploy anything, so it cannot prove that boundary yet.
- Keep the API key and owner connection out of function configuration and Angular.
- Revoke the setup API key when no longer needed. After the trial, disable/delete
  triggers, remove deployed secrets, and remove the dedicated trial project if
  no longer needed. Inspect the actual project before any owner-led deletion.
- OCI setup and its readiness checks remain separate and pending.

## Local verification

`pnpm test` runs offline validation and API-boundary tests; `pnpm run lint` and
`pnpm run typecheck` cover the script. The explicit `test:setup-db` command needs
a fresh disposable local PostgreSQL instance bound to loopback, database
`neondb`, user `postgres`, and the test-only password `berth-test-only`:

```bash
BERTH_TEST_POSTGRES_PORT=your_local_port pnpm run test:setup-db
```

The integration test creates a non-superuser owner, performs bootstrap and denial
probes, refuses a repeated apply, and detects deliberately broadened grants.
Use a fresh test container for each run. It accepts no remote host or URL.
Local PostgreSQL results do not substitute for Neon live acceptance.

Sources: [Neon role privileges](https://neon.com/docs/manage/roles),
[connection URI API](https://neon.com/docs/reference/api/projects/get-connection-uri),
[project API](https://neon.com/docs/reference/api/projects/get-project),
[Functions regions](https://neon.com/docs/compute/functions/overview),
[injected environment variables](https://neon.com/docs/compute/functions/environment-variables),
[PostgreSQL role options](https://www.postgresql.org/docs/current/sql-createrole.html),
[node-postgres TLS](https://node-postgres.com/features/ssl).
