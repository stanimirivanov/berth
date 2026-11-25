# Adopt Ports and Adapters for the application backend

History, Inventory and Retry use Ports and Adapters so their behavior can be
exercised with test doubles and without connecting to hosted services. Each
capability owns the interfaces and types for the operations it offers and the
capabilities it needs. HTTP adapters translate requests and responses.
PostgreSQL and OCI adapters implement application ports. Entry points wire
those implementations to the use cases. Dependency direction applies to
type-only imports as well as runtime imports.

Keep retained trial SQL behind the capability-specific interfaces from
[ADR 0010](0010-separate-application-from-trial-execution.md), including its
decoding, role checks and read-only transaction for History. The trial executor,
qualification probes and owner recovery keep their existing boundaries.

Retry owns the start and status action port used by its HTTP adapter and
implemented by reconciliation. See [#163](https://github.com/stanimirivanov/berth/issues/163).
Retry also owns the observation port and its evidence vocabulary. The OCI
observer implements that port, and the Retry runtime wires it into reconciliation.
See [#153](https://github.com/stanimirivanov/berth/issues/153).

The backend import allowlist enforces the approved dependencies. History's
shared database access policy still depends on trial execution and is tracked
in [#151](https://github.com/stanimirivanov/berth/issues/151).
