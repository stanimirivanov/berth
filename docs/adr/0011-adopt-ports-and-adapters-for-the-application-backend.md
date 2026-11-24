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

Apply this direction through bounded follow-ups. Move the Retry observation
contract into the application in
[#153](https://github.com/stanimirivanov/berth/issues/153) and separate History's
shared database access policy from trial execution in
[#151](https://github.com/stanimirivanov/berth/issues/151). The backend import
allowlist enforces approved dependencies today, including the existing edges
those issues will change.
