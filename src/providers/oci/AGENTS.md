# Narrow OCI provider

`bucket.ts` owns intent/identity/configuration checks and the public Alchemy
resource/provider. `client.ts` alone imports the Object Storage client SDK, pins the home-region
endpoint and dispatches each request through the mandatory budget port. No
administrator, filesystem, environment reader or hosted handler belongs here.

- No adoption, updates, force deletion, recursive deletion, automatic pagination or
  retry loops. Keep unresolved mutations in the caller's durable ledger.
- Use `safeBucketSdk` with a single-send signed transport for live integration;
  never enable SDK debug logging. Fake interfaces alone are not SDK compatibility
  evidence: retain the real SDK transport tests and real Alchemy lifecycle test.
- Run the focused `node --test dist/tests/oci-bucket.test.js` after `pnpm build`,
  and include the real SDK transport tests when changing request behavior.

See docs/trial/oci-bucket-provider.md for integration gates and limitations.

`trial-object.ts` owns only deterministic `trial.bin`, intent/receipt journal ports,
checksum streaming and conditional object cleanup. It may import hashing/streams,
`bucket.ts` for saved bucket verification and `client.ts` for the budgeted object
adapter; it cannot import SDKs directly. Reconciliation after a lost PUT requires
precommitted pending intent, exact metadata/bytes and any saved revision. Never
replay a pending absent upload. See docs/trial/oci-object-probe.md.

`storage-evidence.ts` uses the OCI SDK signer for two bounded, fixed GETs
for region subscriptions and tenancy-root storage allowance evidence, plus
one fixed read-only Usage API POST under the same scheduled claim and deadline.
`monthly-usage-report.ts` decodes billed-SKU daily usage. Read the
[OCI allowance evidence contract](../../../docs/oci-storage-allowance.md) when
changing scope, units, freshness or cutoff handling. Retain the pinned signer
transport fixture when changing the wire contract.
