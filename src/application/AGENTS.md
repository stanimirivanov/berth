# Application backend

- History owns the authenticated retained operation read interface. Keep reads
  in the existing read-only transaction and preserve the public History routes.
- Inventory owns its typed read port and offering and presence projection.
  Its HTTP adapter uses the port. The retained adapter owns the restricted
  database connection and role switch. See the
  [Inventory API contract](../../docs/trial/managed-inventory-api.md).
- Retry owns the owner action session, reconciliation and status. It uses the
  fixed read-only OCI observer. Keep provider credentials server-side.
- Use the matching adapter under `retained-trial-ledger/` for all retained trial
  SQL. Each adapter exposes the interface for its own role. Keep the executor,
  trial admission, qualification tools and recovery paths outside this module.
- Run `pnpm check`, the affected local bundle builds and disposable PostgreSQL
  suites. See [ADR 0010](../../docs/adr/0010-separate-application-from-trial-execution.md).
