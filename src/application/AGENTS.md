# Application backend

- History owns the authenticated retained operation read interface. Keep reads
  in the existing read-only transaction and preserve the public History routes.
- Inventory owns its offering and presence projection. The reader uses its
  existing restricted SQL capability. The hosted route and same-origin proxy
  belong to issue #118.
- Retry owns the owner action session, reconciliation and status. It uses the
  fixed read-only OCI observer. Keep provider credentials server-side.
- Use the matching adapter under `retained-trial-ledger/` for all retained trial
  SQL. Each adapter exposes the interface for its own role. Keep the executor,
  trial admission, qualification tools and recovery paths outside this module.
- Run `pnpm check`, the affected local bundle builds and disposable PostgreSQL
  suites. See [ADR 0010](../../docs/adr/0010-separate-application-from-trial-execution.md).
