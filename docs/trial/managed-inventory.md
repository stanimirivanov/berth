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

## Record independent owner evidence

Apply `010_inventory_evidence.sql` after the fenced executor and inventory
migrations. It captures the verified executor bucket checkpoint, a pending
delete against that identity, and verified removal at teardown. There is no
additional provider request. The executor retains the exact conditional-delete
revision and the reference and time of the verified absence check. It publishes
queued observations after releasing its execution claim. If publishing is
interrupted at closeout, the database owner can publish the already queued
evidence with `SELECT berth_inventory.publish_executor('<operation-uuid>')`.
That call performs no provider work. Pending publication keeps coverage
incomplete. Older checkpoints and name-only evidence require qualification.
The read service needs only the existing reader capability.

1. As the database owner, create a dedicated login named
   `berth_inventory_submitter`, grant it `berth_inventory_recorder`, and set
   its password interactively. Grant no other application role to this login.
   Store its Neon connection URL in an owner-only file outside the checkout.
2. Independently reconcile or clean up under the existing owner procedure.
   Keep the authenticated OCI responses privately. Build a separate, owner-only
   JSON receipt using the fields below. Use the provider observation time and
   a stable reference to the retained source. Review the receipt against those
   responses before recording it. The owner attests to the source and SQL
   checks the receipt and the retained operation. The command makes no OCI
   requests and does not verify raw OCI responses on its own.
3. Submit one receipt from the repository root.

   ```bash
   pnpm run inventory:record-owner \
     --database-url-file /absolute/private/recorder-url \
     --receipt-file /absolute/private/receipt.json
   ```

   Both files must be readable only by their owner. A successful write prints
   `recorded` or `already-recorded`. A conflict or failed submission leaves
   the receipt available for review. Preserve it and reconcile any unknown
   commit outcome before retrying. The command prints no receipt values.

| Receipt field | Value from the retained evidence |
| --- | --- |
| `reference` | Stable private journal entry reference, up to 200 characters from letters, digits, `.`, `_`, `:`, `/` and `-` |
| `operation` | Saved Berth operation UUID |
| `observedAt` | UTC ISO timestamp ending in `Z` for the completed observation |
| `kind` | `present` or `removed` |
| `bucket` | `id` (exact OCI bucket OCID), `region`, `namespace`, `compartment` (OCID), `name`, `operationTag` and `marker` (both ownership tags), and `etag` (the verified revision) |
| `observation` for presence | `status: 200` and `requestId` from the authenticated bucket GET |
| `observation` for removal | `deleteStatus: 204`, `ifMatch` equal to the recorded bucket ETag, `absentStatus: 404`, `listingComplete: true`, `targetListed: false`, and the `deleteRequestId`, `getRequestId` and `listRequestId` from the three requests in the saved scope |

Receipt replay is keyed by the stable private source reference. A
standalone `404`, an incomplete listing, or an unmatched identity cannot
establish removal. The owner-only command leaves expiry, outcomes, request
accounting, and the cleanup reserve intact. See
[ADR 0008](../adr/0008-reconcile-in-berth-and-admit-independent-owner-evidence.md).
