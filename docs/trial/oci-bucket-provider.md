# Narrow OCI bucket provider — issue #8

This is an offline contract-tested provider, not a deployed OCI workflow. It uses
Alchemy's public `Resource`, `Provider.succeed`, `Plan.make`, `Plan.destroy` and
`apply` APIs. The tests exercise the actual pinned engine with in-memory state,
a fake OCI service, and the actual pinned SDK with an injected HTTP transport.
No OCI resources or credentials are used by these tests.

## Contract

- Inject the saved immutable ledger intent: operation, server-generated marker,
  derived bucket name, namespace, compartment and attested home region.
- `makeBucket().plan()` returns the exact private Standard create proposal without
  requests. Alchemy planning may inspect existing resources but does not create or
  delete them. Apply checks again before mutation.
- Create stamps both operation and marker tags. Versioning and auto-tiering are
  explicitly disabled; events are false; omitting a KMS key selects Oracle-managed
  encryption. Reads reject public access, replication, read-only replica state,
  customer keys, lifecycle policies, retention rules and preauthenticated grants.
  Missing required safety metadata fails closed.
- Persist provider OCID, ETag, operation and marker. A matching name or marker
  without the saved provider identity is insufficient for adoption. Replacement,
  intent mismatch and unexpected configuration stop the operation.
- Only a complete authenticated compartment bucket listing proves absence. A
  continuation token, extra bucket, 401, 403, 404 or unavailable service cannot
  establish absence. No automatic pagination exists.
- Delete verifies ownership and configuration, checks objects and multipart uploads,
  fetches a fresh revision, then sends `if-match`. A changed revision, nonempty
  bucket, 409 or 412 stops deletion; there is no unconditional retry or content
  sweep. A final authenticated empty listing confirms removal. Failure of that
  final read leaves completion unverified.

The [OCI bucket guide](https://docs.oracle.com/en-us/iaas/Content/Object/Tasks/managingbuckets.htm)
and [IAM permission reference](https://docs.oracle.com/en-us/iaas/Content/Identity/Reference/objectstoragepolicyreference.htm)
explain the provider controls and permissions. `BUCKET_CREATE` does **not** enforce
private-only creation or a one-bucket cap. IAM is not a spending cap. The dedicated
empty compartment, application validation, dispatcher budget and owner allowance
attestation remain necessary. Existing `BUCKET_READ` and `OBJECT_INSPECT` trial
grants cover these inspections; no policy expansion is included here.

## Dispatcher and live integration obligations

1. Construct `safeBucketSdk` using a signed, single-send transport, with retries
   disabled and no SDK debug logger. The wrapper removes service error bodies and
   identifiers before the SDK's retry diagnostics. Close the client after use.
2. Pass that SDK to `bucketClient` with the attested home region and an implementation
   of `BudgetedDispatcher`. Every SDK request, including each read, goes through
   `dispatch`. The adapter enforces per-request `NoRetryConfigurationDetails` and
   prevents a dispatcher from invoking a callback twice.
3. The dispatcher must reserve **and commit** one request in the operation ledger
   before invoking the callback. Duplicate/missing reservations must not invoke it.
   Carry the immutable lease generation and bounded action attempt. Do not wrap the
   SDK in a retrying HTTP transport. A callback is one send, not a logical operation.
4. Preserve pending mutation intent on ambiguous failures or process interruption.
   Provider exceptions contain fixed categories only. Do not log the original
   dispatcher error or settle an ambiguous create/delete as successful. A provider
   read alone is not permission to replay an unresolved mutation.
5. Inject `bucketProvider(intent, client, true)` for destroy planning/apply. It
   charges inspection to `inspect_cleanup` and refuses reconciliation/creation.
   Ordinary planning/apply uses the default mode and `inspect`. Delete always uses
   cleanup inspections and `delete_bucket`. Exhausting normal budget must not
   consume the protected cleanup reserve.
6. Record authenticated absence evidence separately before completing the operation.
   The cleanup provider permits already-absent resources; the ordinary provider
   refuses to recreate a saved resource that disappeared.

The concrete ledger-to-dispatcher wiring, OCI payload support in the currently
synthetic-only fenced state validator, and hosted orchestration are later work.
Do not deploy this provider by bypassing those gates. Lost create responses require
explicit reconciliation of saved intent, remote identity and pending mutation;
there is deliberately no automatic adoption/recovery command in this slice.

Conditional deletion is verified here at the SDK serialization and fake-service
boundaries. Live OCI revision behavior, permission denials, eventual consistency,
usage/headroom and teardown evidence remain required at gated live acceptance.
ETag preconditions do not fence external administrators or prevent concurrent
object uploads; the service's nonempty rejection is the final protection. External
mutation or delayed listing may conservatively stop the trial for reconciliation.

## Local verification

```bash
pnpm build
node --test dist/tests/oci-bucket.test.js
pnpm check:fast
pnpm check
```

The focused suite covers exact proposal/markers, ownership and configuration drift,
authorization/unavailability, uncertain creation/deletion confirmation, budget denial,
no hidden retries, conditional header serialization, revision/nonempty rejection,
redacted diagnostics and public Alchemy plan/apply/destroy with cleanup-only budget.
These results are not live cloud acceptance evidence.

Verification on 2026-11-13: `pnpm check` passed (80 application tests, 18 harness
checks, strict types/lint, Neon probe bundle and secret scans). The 11 provider
contracts include actual SDK serialization and Alchemy lifecycle checks. Inverting
the fresh-revision guard caused three tests to fail; restoring it returned the suite
to green. The dependency audit retains seven moderate and one low findings, with no
high/critical findings and no dependency changes in this issue.

## Opt-in metadata contract — issue #57

OCI GetBucket exposes `autoTiering` as an optional `fields` selection in the pinned
SDK's `GetBucketRequest`. CreateBucket returning `Disabled` does not imply that a
later ordinary GET includes that setting. The shared budgeted `bucketClient.get`
now explicitly requests `GetBucketRequest.Fields.AutoTiering`, including the fresh
read immediately before conditional deletion. This adds no request, retry or
budget unit; it changes the query on the existing metered request.

Validation still requires the explicit `Disabled` value. Missing, unknown and
`InfrequentAccess` values fail with the existing safe `BucketFailure` category
`configuration`; ownership, revision and all other configuration checks remain
unchanged. The hosted SQL reason remains the existing generic reconciliation
category; this fix does not widen its public/schema diagnostic vocabulary.

`tests/oci-bucket-metadata.test.ts` exercises the real pinned SDK over a local
transport that returns the field on create and omits it on GET unless selected.
The regression first failed at the post-create read, then passed through read and
conditional teardown. It checks all three bucket GETs, one reservation per send,
cleanup-only dispatch and strict rejection of unsafe/missing settings. The shared
`FakeOci` now models optional field selection too, so object/executor/recovery
fixtures cannot silently conceal the same omission.

This code-only correction follows the [recorded live failure and manual recovery](https://github.com/stanimirivanov/berth/blob/7995f46/docs/trial/live-results.md#hosted-failure-and-bounded-owner-recovery)
in draft PR #50. It does not change that partial/no-go verdict, prove hosted
teardown or authorize another trial. The one-use exception remains consumed;
no cloud credentials, deployments or resources are used by these tests.

Verification for #57 on 2026-11-15: `pnpm check` passed (158 application tests,
28 harness tests, types/lint, bundle, secret scan and advisory gate). Disposable
loopback PostgreSQL setup and all 19 executor/admission tests passed. All three
existing interrupted object-deletion cases passed at 35/40 cleanup requests;
the full crash matrix was not rerun locally, and its CI coverage is unchanged.
The live executor bundle also built locally; nothing was deployed. Existing seven
moderate and one low dependency advisories remain, with no high/critical findings.
