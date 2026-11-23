# Bounded Retry provisioning reconciliation

This service implements the observation and status part of
[ADR 0009](../adr/0009-retry-provisioning-from-operation-detail.md).
A completed check identifies the exact owned bucket or reports that a write
could be considered. Approval and dispatch of further provisioning belong to
[#141](https://github.com/stanimirivanov/berth/issues/141).

## Owner action contract

The hosted bundle has no schedule. It accepts exact routes, with no query
parameters and empty POST bodies. Use an authorization header for every route.
Responses carry `Cache-Control: no-store`.

| Method and path | Bearer credential and response |
| --- | --- |
| `POST /api/retry/session` | Dedicated retry owner credential. Returns a retry-only `session` and `expiresAt` valid for five minutes. |
| `POST /api/retry/operations/:operation` | Retry session. Starts the saved operation's check once, or returns its durable status. Returns `202` while another request is checking. |
| `GET /api/retry/operations/:operation` | Retry session. Returns recorded status or `404` if no check was started. Performs no OCI work. |

The server's `BERTH_RETRY_OWNER_CREDENTIAL` contains
`berth-retry-owner-v1.` followed by the base64url encoding of at least 32
cryptographically random bytes. Keep the credential and issued session out of
URLs, logs and browser storage. Rotate the credential to invalidate sessions.
History and trial tokens use different formats and separate authority.

Return states are `checking-provider`, `completed` and `needs-attention`.
Completed means reconciliation finished. The result is `owned-instance` or
`safe-write-needed`. Stop responses include a fixed reason and a link to the
owner recovery procedure. The API omits provider identifiers, revisions,
request IDs and raw provider errors.

## Scope and accounting

- One durable check can be started per operation. A duplicate neither resets
  the check nor extends its 20-second limit. Within the original window, the
  check respects the earlier of its own deadline and the creation cutoff. It
  charges the original normal request allowance and stops if that allowance
  is exhausted or cleanup has started. After expiry it uses separate authority and
  accounting for OCI reads.
- The service commits each request reservation before its single signed GET.
  A 404 permits one scoped ListBuckets GET. Pagination, a mismatched response,
  or a lost request yields a stop. An empty listing leaves a timed-out write
  unresolved. Status shows the committed reservations even after interruption.
- Match the saved compartment, namespace, name, operation marker and known OCI
  identity before recording verified presence at the OCI response time. A
  pending write affecting another step, configuration drift, or cleanup
  can still require attention. Preserve the original outcome, expiry and
  cleanup reserve. Post-expiry checks leave the original request counters
  intact. An unqualified provider observation stays private and does not
  update the inventory projection.

## Installation prerequisites

Apply migration 011 after migrations 001–010 as the dedicated owner. Grant
`berth_retry_action` to a login named `berth_retry_runtime`, with no other
application role or table privileges. Set `BERTH_RETRY_DATABASE_URL` to that
login's TLS-verified Neon URL.

Use a separate OCI principal with only the Object Storage read permissions
needed for GetBucket and ListBuckets in the saved compartment. Provide its
`BERTH_RETRY_OCI_TENANCY`, `BERTH_RETRY_OCI_USER`, `BERTH_RETRY_OCI_KEY` and
`BERTH_RETRY_OCI_FINGERPRINT`, plus the pinned
`BERTH_RETRY_OCI_REGION`, `BERTH_RETRY_OCI_NAMESPACE` and
`BERTH_RETRY_OCI_COMPARTMENT`. Provisioning and teardown credentials belong to
their existing services.

`pnpm run build:retry` creates a local bundle. `pnpm run test:retry-db`
uses the same complete migration sequence with a disposable PostgreSQL fixture
and synthetic OCI responses.
