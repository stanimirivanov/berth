# Narrow OCI provider

`bucket.ts` owns intent/identity/configuration checks and the public Alchemy
resource/provider. `client.ts` alone imports OCI SDK packages, pins the home-region
endpoint and dispatches each request through the mandatory budget port. No
administrator, filesystem, environment reader or hosted handler belongs here.

- Follow ../../../docs/comment-quality.md. Explain ownership, failure and budget
  obligations on exported contracts and substantial helpers.
- No adoption, updates, force deletion, recursive deletion, automatic pagination or
  retry loops. Keep unresolved mutations in the caller's durable ledger.
- Use `safeBucketSdk` with a single-send signed transport for live integration;
  never enable SDK debug logging. Fake interfaces alone are not SDK compatibility
  evidence: retain the real SDK transport tests and real Alchemy lifecycle test.
- Run the focused `node --test dist/tests/oci-bucket.test.js` after `pnpm build`,
  followed by canonical harness checks. No live cloud writes in this issue.

See docs/trial/oci-bucket-provider.md for integration gates and limitations.

`trial-object.ts` owns only deterministic `trial.bin`, intent/receipt journal ports,
checksum streaming and conditional object cleanup. It may import hashing/streams,
`bucket.ts` for saved bucket verification and `client.ts` for the budgeted object
adapter; it cannot import SDKs directly. Reconciliation after a lost PUT requires
precommitted pending intent, exact metadata/bytes and any saved revision. Never
replay a pending absent upload. See docs/trial/oci-object-probe.md.
