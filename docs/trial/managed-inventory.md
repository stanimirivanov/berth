# Managed inventory storage

Migration `009_managed_inventory.sql` adds owner-held inventory tables and a
restricted read function. Apply it as `neondb_owner` in the dedicated
`neondb` after the operation ledger migration. The owner needs authority to
create the `berth_inventory_reader` capability role. Assign that role only
to a dedicated reader when the inventory endpoint is wired.

- An instance has an opaque Berth UUID, a private OCI bucket OCID and a
  retained operation. A reused bucket name can identify several instances.
  The schema allows one OCI bucket identity per retained operation.
- Observations bind to the exact OCI bucket OCID. The latest observation
  determines presence. Unresolved create or delete keeps the instance
  visible, together with its last verified presence time if one exists.
  Verified removal clears that instance from the current page and preserves
  its dated observations and the operation's outcome.
- Coverage is assessed across retained operations for the OCI Object Storage
  bucket offering. Missing scope review, unmatched operations, explicit
  gaps, and conflicting coverage records leave coverage incomplete.
  Installing the migration alone yields an empty page with incomplete
  coverage.

The reader calls `berth_inventory.inventory_page(after, limit)` with a
nullable UUID cursor and a limit from 1 to 50. It returns an offering key,
coverage, instance summaries and the next cursor. Each instance summary
contains its opaque UUID, display name, region, presence, last verified
presence time, latest observation time, uncertainty reason and operation UUID.
The endpoint should set a query deadline on the database session before reading
inventory, as the Operation history service does.

Evidence intake and historical seeding are separate work. The storage
migration applies no retained trial evidence and reads no provider state.
See [ADR 0007](../adr/0007-serve-managed-inventory-from-retained-evidence.md).

## Verification

Run this against a disposable loopback PostgreSQL fixture initialized with
`pnpm run test:setup-db`. The inventory test installs and drops fixture
schemas and roles.

```bash
BERTH_TEST_POSTGRES_PORT=<fixture-port> pnpm run test:inventory-db
```
