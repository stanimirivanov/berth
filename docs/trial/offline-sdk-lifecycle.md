# Offline full-lifecycle OCI SDK contract — #64

The new `tests/oci-sdk-lifecycle.test.ts` composes the actual pinned OCI SDK,
`safeBucketSdk`, budgeted bucket/object adapters and lifecycle helpers with an
independent in-memory HTTP transport. `tests/fakes/oci-wire.ts` handles HTTP paths,
headers, request bytes and response revisions directly; it does not import a Berth
provider or delegate responses to `FakeOci`/`FakeObjects`. No socket, signing key,
cloud account or schedule is used by this proof.

## Evidence

The success control creates and reads the private Standard bucket, persists fixed
intent before create-only PUT, uploads 1 MiB, HEADs and revision-binds GET, consumes
the actual SDK response stream and verifies the deterministic SHA-256. It then
rehydrates cloned intent/bucket/receipt into fresh lifecycle helpers with a fresh
SDK instance. Read and repeated upload preserve exactly one PUT. Teardown deletes
the owned object and bucket conditionally and proves absence; repeated bucket
removal lists absence without issuing another DELETE.

Every actual SDK wire send must have exactly one preceding budget dispatch. The
success control uses **36/160 normal requests**, **24/40 for owned teardown** and
**25/40 including the repeated authenticated absence check**. Tests enforce ceilings
and cleanup-only action classification rather than treating these counts as a new
budget. The counters are an offline dispatcher sensor, not SQL reservations or
provider-billed usage. Existing SQL ledger and interrupted-teardown tests remain.

Independent unsafe-response controls prove that corrupt streamed bytes, foreign
metadata, a replaced object revision and an incomplete listing stop deletion.
An HTTP 412 conditional DELETE response leaves resources present and results in
exactly one conditional send, with no retry or unconditional fallback. Existing
retryable-error SDK tests and broader ownership/configuration tests remain intact.

The HTTP model omits GetBucket autoTiering unless the request explicitly selects
that optional field. It sends real opc-meta-* headers, content length, storage tier,
version IDs and ETags, so the production SDK performs its own response projection.
It models only the trial's supported API subset; unknown routes fail locally rather
than falling back to a network transport.

## Failing-first and adversarial verification

The new integration tests first failed at the missing HTTP transport behavior.
After implementation, all success and unsafe-response controls passed. Two review
mutations then established sensor sensitivity:

- Removing the production adapter's optional autoTiering field selection failed
  the new suite at bucket inspection.
- Removing its body checksum comparison failed the corrupt-stream deletion guard.

Both mutations were restored immediately. The PR changes only tests, the offline
transport fixture and documentation; no production validator, retry, allowance,
request cap or recovery assertion was weakened or removed.

Run the focused proof with:

```bash
pnpm build
node --test dist/tests/oci-sdk-lifecycle.test.js
```

The full repository check uses the existing approved `check:temporary-audit` path
before its November 25 UTC expiry. It retains native audit failure and report
artifacts; this proof adds no new dependency exception. Qualification requires a
clean committed checkout, so final verification follows the implementation commit.

## Limits and relation to the live trial

This is real SDK serialization/deserialization and stream behavior against a
synthetic HTTP service. It does not establish OCI IAM, request signing, eventual
consistency, actual conditional-deletion semantics, metrics/warnings, billing,
Alchemy engine/SQL fencing or hosted scheduling behavior. Those remain separate
tests and/or live evidence requirements. In particular, the prior #14 failed
lifecycle / partial verdict is unchanged, and the one-use exception is consumed.

PRs #50 and #60 were separately rebased onto current main and retained as drafts.
Their dated evidence was preserved; #60 additionally records the administrator's
November 18 15:44:14 UTC GetCompartment result DELETED. No live trial or repeated
mutation accompanied those rebases. A future live run requires separate explicit
owner authorization; this offline success does not grant it.
