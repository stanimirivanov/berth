# Managed Inventory read API

`GET /api/inventory` serves the retained OCI Object Storage bucket projection
under [ADR 0007](../adr/0007-serve-managed-inventory-from-retained-evidence.md).
Use optional `after` from the previous page and `limit` from 1 to 50 (default 20).
The cursor is an opaque canonical UUID. A null `next` ends pagination.

A successful page returns `offering`, `coverage`, `items` and `next`. Each item
contains `instance`, `displayName`, `region`, `operation`, `presence`,
`observedAt`, `lastVerifiedAt` and `uncertainty`. Complete coverage with
zero rows on the first page means **No known instances**. Incomplete coverage
retains any known rows and signals a coverage gap. An unavailable service
returns `503` with `inventory-unavailable`. Pages returns `401` for denied
browser credentials and `403` for an unsupported origin. Reads use retained
SQL evidence and grant no execution authority.

## Bindings and database access

| Runtime | Binding | Value |
| --- | --- | --- |
| Pages | `BERTH_HISTORY_SITE_ORIGIN` | Existing HTTPS Berth origin |
| Pages | `BERTH_HISTORY_ACCESS_TOKEN` | Existing browser Owner access token |
| Pages | `BERTH_INVENTORY_NEON_ORIGIN` | HTTPS origin of the dedicated Inventory Neon Function |
| Pages | `BERTH_INVENTORY_UPSTREAM_TOKEN` | Inventory-only service token |
| Neon Inventory Function | `BERTH_INVENTORY_TOKEN` | The same Inventory service token supplied to Pages |
| Neon Inventory Function | `BERTH_INVENTORY_DATABASE_URL` | Dedicated `berth_inventory_runtime` login on `neondb` |
| Neon Inventory Function | `DATABASE_URL` and `DATABASE_URL_UNPOOLED` | Override each injected value with the same restricted URL as `BERTH_INVENTORY_DATABASE_URL` |

Use a 32–128 character service token drawn from letters, digits, underscore
and hyphen. Keep it distinct from the browser credential and the History
service token. Pages forwards one GET with the Inventory service token,
refuses redirects, limits the JSON response to 128 KiB, and uses a four-second
request timeout.

Neon supplies both default database URLs on Postgres-enabled branches.
Override both on this Function before enabling reads. The reader rejects
configurations with a different URL in either binding.
[Neon Function environment variables](https://neon.com/docs/compute/functions/environment-variables)

For separately authorized setup, verify the restricted database setup and
the ledger and Inventory migrations through 010 on the target branch.
Migration 010 updates the projection to account for evidence intake and
in-flight deletes. Install missing migrations in order using the documented
owners. In an administrator `psql` session on the dedicated database, create the login
and grant only the Inventory membership:

```sql
CREATE ROLE berth_inventory_runtime LOGIN NOINHERIT;
GRANT berth_inventory_reader TO berth_inventory_runtime WITH INHERIT FALSE, SET TRUE;
```

Set the login password privately with `\password berth_inventory_runtime`.
The adapter checks the login and grants before assuming the reader role in a
read-only transaction. The login must have only that role membership and the
database must retain its restricted public grants. The adapter verifies TLS,
uses bounded connection and query timeouts, and closes the connection after
each read.

## Local verification

Run `pnpm build:inventory` to produce `dist/inventory.zip`. Run the focused
Inventory API and Pages proxy tests, and `pnpm test:inventory-db` against a
fresh disposable PostgreSQL instance on loopback after `pnpm test:setup-db`.
These checks use synthetic data.
