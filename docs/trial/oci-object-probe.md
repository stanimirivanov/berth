# Owned 1 MiB object probe — issue #9

`trial-object.ts` implements only `trial.bin`: 1,048,576 bytes, where byte N is
N modulo 256. Its SHA-256 is
`fbbab289f7f94b25736c58be46a994c441fd02552cc6022352e3d86d2fab7c83`.
There is no arbitrary upload, overwrite, multipart writer, object browser or
recursive deletion. Tests use fake OCI and the pinned SDK with a fake transport;
no account credentials or cloud mutations are involved.

## Required integration

1. Generate `probeIntent(bucketIntent)` from the saved operation marker and exact
   bucket target. The name agrees with the ledger's fixed `trial.bin`; pass its
   digest into operation creation. Rehydrate `ProbeRecord` only from trusted,
   fenced durable state, including the saved bucket identity and any object receipt.
2. Supply `ProbeJournal`: `saveIntent` must commit immutable name/digest/marker
   before PUT; `saveReceipt` must persist the provider ETag with the bucket identity
   under the current lease generation. It must be idempotent and must not modify
   previous evidence to match an unrelated resource. Neither callback may log secrets.
3. Use `objectClient` with `safeBucketSdk` and the same committed-reservation
   dispatcher described in [the bucket provider guide](oci-bucket-provider.md).
   No operation bypasses a reservation. Per-request SDK retries are disabled;
   transports must also be single-send, without automatic retries or debug logging.
4. Call `upload()`. Before PUT it inspects the owned bucket configuration, complete
   bounded object/version inventories and outstanding multipart work. PUT uses
   `If-None-Match: *`, exact length and ownership/digest metadata. Its returned ETag
   is saved **before** the follow-up HEAD/GET. A receipt records intended digest and
   observed identity; only a successful checksum read establishes matching bytes.
5. HEAD establishes the revision and metadata. GET uses `If-Match` for that ETag,
   revalidates metadata and hashes exactly 1 MiB. Both Node and Web response streams
   are supported; metadata, length, checksum or revision failure cancels the stream.
   The helper never hashes beyond the byte bound; the live transport/host must also
   impose request and execution deadlines, including stalled stream reads.
6. Repeated `upload()` observes saved identity without another PUT. On restart,
   rehydrate the receipt. If PUT's response was lost, trusted durable pending intent
   permits read-only reconciliation against the exact marker, target, metadata and
   bytes. Without that evidence, even matching content is not adopted. Missing
   content after a pending upload stops; it never triggers automatic re-upload.
7. `remove()` uses only cleanup reservations. It checks inventory, ownership and
   checksum, saves the observed revision, rechecks bucket configuration/inventory,
   then DELETEs with the inspected `If-Match`. A final authenticated inventory
   establishes absence. The bucket helper may then delete the empty owned bucket.

Concrete SQL journal/dispatch wiring and hosted orchestration are still gated work;
these injected ports are not a durable implementation by themselves. Keep pending
mutations until the ledger records provider evidence. Do not treat a helper error,
lease expiry or process interruption as successful cleanup. Host cancellation may
interrupt the function after provider success, so the caller must preserve uncertainty.

## Stop and recover

All errors use fixed `BucketFailure` codes; they contain no service bodies or
credentials. Retain the journal and inspect/reconcile; never force-empty the bucket.

| Code | Required response |
| --- | --- |
| `identity-unrecorded` / `ownership` | Confirm saved intent, marker, bucket identity and prior receipt; never adopt a name or checksum alone. |
| `collision` | Inspect unexpected names or incomplete inventory; do not remove unrelated objects. |
| `configuration` | Inspect retention, version history/delete markers, public/replication drift, multipart work or object headers. No automatic version/PAR/retention deletion exists. |
| `revision` / `precondition` | A response or current revision differs; preserve the replacement and reconcile. Never retry without the precondition. |
| `checksum` | Content is corrupt, short, oversized or not a byte stream; do not delete it. |
| `forbidden` / `unavailable` | Restore/verify read access; failed reads and 404s never prove absence. |
| `unknown-outcome` | Read the saved intent/receipt and provider state; a lost response or failed journal write requires reconciliation. Do not replay an absent pending upload. |
| `budget` | Stop normal work; use reserved cleanup where possible. Exhausted cleanup requires owner recovery. |

Only an optional single `null` version entry for the intended current object is
accepted; any historic version, delete marker, pagination or unexplained prefix
stops. The bucket must also report versioning disabled. OCI documents versioning
and history in its [versioning guide](https://docs.oracle.com/en-us/iaas/Content/Object/Tasks/usingversioning.htm).
`ListObjectVersions` requires `OBJECT_INSPECT`, already in the restricted trial
policy; see the [OCI permissions reference](https://docs.oracle.com/en-us/iaas/Content/Identity/Reference/objectstoragepolicyreference.htm).
Live response shapes and conditional mutation semantics still require gated acceptance.

ETag and marker checks protect against accidental collisions and replacements,
not a malicious administrator. The dedicated compartment must remain reserved
against concurrent owner writes. Metadata normalization is explicit because the
pinned SDK returns `opc-meta-` prefixes on response keys but accepts unprefixed PUT keys.

## Verification

```bash
pnpm build
node --test dist/tests/oci-trial-object.test.js dist/tests/oci-bucket.test.js
pnpm check:fast
pnpm check
```

Contracts cover exact bytes/digest, persistence ordering, unrelated contents,
identical bytes with wrong marker, lost upload response, no overwrite/replay,
revision races, authorization failures, version/retention checks, short/oversized
and corrupt streams, budget denial and cancellation. The actual SDK transport
checks create-only and revision headers, metadata normalization and one-send
precondition failures. A clean object-plus-bucket teardown fits the 40-request
cleanup reserve; retries, drift and outages can still exhaust it. These tests do
not establish live usage, billing, permission or teardown evidence.

Verification on 2026-11-13: all 15 focused object contracts and canonical
`pnpm check` passed (95 application tests, 19 harness tests, strict types/lint,
probe bundle and secret scans). Inverting checksum equality caused 11 failures;
the restored implementation passed. No dependencies changed; the audit retains
seven moderate and one low findings with no high/critical findings.
