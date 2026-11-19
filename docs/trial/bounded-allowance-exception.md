# One-operation allowance evidence exception — #78

The owner accepted this policy for the proposed issue #76 validation on November
19, 2026. It removes specified evidence blockers only. **No provisioning, Neon
migration installation, deployment or live trial is authorized by this PR.** The
old failed/partial-no-go verdict, completed closeout and consumed #55 slot remain.

## Contract and trust

Migration `007_bounded_allowance_exception.sql` is a one-time owner-only addition
after 001–006. It creates a separate immutable singleton, and wraps preparation,
status and reporting. Migration 006's strict validator remains available internally
for evidence without this exception. Apply neither migration now; installation on
Neon requires separate authorization and predecessor/state inspection.

For a separately approved new operation, the owner supplies the existing
`free-plan-unknown-v1` evidence and Functions policy. Retain all its commitments,
including exclusive Berth use of the Neon project, manual recovery, partial outcome,
measured probe/scenario, four-hour binding and shutdown by expiry + 15 minutes.
The additional unknown activity acceptance concerns potentially concurrent account
consumption; it does not fabricate an exclusivity attestation if that too is unknown.

Keep known OCI storage and Postgres storage/compute capacity. Omit root
`objectRequests`, `transferBytes`, `monitoringRequests` and
`functionsPolicy.allowances.sharedTransferBytes`; their missing values are not
filled from forward estimates. Retain `requiredSharedTransferBytes` and the known
Postgres values. Existing Functions numeric fields and `functionsException` remain
forbidden. Configuration is exactly 64 application units and 20 Monitoring calls.

Add `allowanceException` with:

- `version: "issue76-once-v1"`, `issue: 76`, and nonsecret `approvalRef` identifying
  the actual owner's separate approval of this operation/target/identity/window.
- Literal `unknownActivityAccepted: true` and `quotaFailureAccepted: true`.
- `ociFree`: `status: "free-tier"`, `source: "owner-console"` or `"provider-api"`,
  `checkedAt`, `evidence`, `billingEvidence` and `billingReviewedAt`. Both timestamps
  are nonfuture epoch milliseconds, fresh through start + 30 minutes under the
  existing 24-hour evidence rule. `accountType` must be `always-free`; a paid or
  promotional-credit fallback cannot claim this exception.
- `meters`: exactly the five keys in the table below. No other evidence may be waived.

| Meter | Required envelope floor / normalized unit | Raw units accepted |
| --- | --- | --- |
| `neonSharedTransfer` | Existing reviewed `requiredSharedTransferBytes`, at least 1,048,576 bytes | `bytes` |
| `ociObjectRequests` | 200 requests, including all 40 cleanup | `requests`, `10K Requests` |
| `ociOutboundTransfer` | 1,048,576 bytes | `bytes`, `GB`, ambiguous `GB Months` |
| `ociMonitoringIngestion` | At least one datapoint; reviewed requirement may be larger | `datapoints`, `Million Datapoints` |
| `ociMonitoringRetrieval` | At least 100 datapoints: conservative five hourly points for each of the existing 20 calls | `datapoints`, `Million Datapoints` |

Every meter supplies `observed` (a finite nonnegative raw number or `"not-exposed"`),
`unit`, `required` (a positive safe integer in the normalized unit), `remaining`
(number or `"unknown"`), `coverage`, `knownInsufficient: false`, `sourceRef`,
`periodRef` and `checkedAt`. The source/period references and approval identifiers
use 1–80 letters, digits, underscores or hyphens; detailed originals remain private.
These references are owner-reviewed evidence, not cryptographic authentication of
provider billing. Never include secrets in any field or test fixture.

- Unavailable observations require `observed=unit="not-exposed"`,
  `coverage="unavailable"` and `remaining="unknown"`.
- Partial numeric observations require `coverage="partial"` and unknown remaining
  capacity. Preserve their original units; partial data is not assumed zero.
- Known numeric remaining capacity requires `coverage="complete"`, a reviewed
  `normalizationRef`, and an integer remaining amount covering `required`. It must
  not exceed the reviewed Free allowance minus observed normalized consumption.
- Ambiguous `GB Months` outbound data can be retained only with unknown remaining;
  it is never automatically converted to bytes. A known insufficient flag rejects
  even where coverage is partial. Explicit low remaining values also reject.
- Recognized raw-unit consumption is independently checked against frozen Free
  policy ceilings after adding the required envelope. For example, five units of
  `10K Requests` already exhaust 50,000 requests and cannot be relabeled unknown.
  Recognized raw consumption is rounded upward to a whole normalized unit using
  exact decimal arithmetic consistently in TypeScript/SQL; no float epsilon is used.
  Required amounts above the Free ceilings and invented oversized remaining values
  reject. Unsupported types/units, stale observations and extra/missing meters reject.

The version freezes 5,000,000,000 shared Neon transfer bytes, 50,000 OCI requests,
10,000,000,000,000 OCI outbound bytes, 500,000,000 ingestion and 1,000,000,000
retrieval datapoints. Sources reviewed November 19:
[Neon allowances](https://neon.com/docs/introduction/plans),
[Oracle Always Free](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm).
These are validation ceilings, not measured remaining amounts or hard spending caps.
Changes to the applicable plans/terms require stopping and reviewing the policy.

## Single-use enforcement and safe failures

Only the owner can call preparation. Preparation inserts the complete immutable
Functions policy and single-use exception binding atomically; a competing/second
exception rolls back rather than leaving a new trial or partial approval. An
`approvalRef` does not itself supply permission; the owner verifies its actual
external approval before preparing. No operation is approved or prepared in this PR.

Preview/submit load server-held evidence. SQL independently checks the same policy
and immutable singleton through submission, attempt creation and dispatch reserve.
An altered target, identity, window, snapshot, mode or policy cannot reuse it.
Identical valid preview replay remains idempotent, not a new operation. Runtime
has no direct table privileges or access to internal preparation bypass functions.

Malformed/expired evidence returns `evidenceBound=false` for a matching deployment
binding; it does not throw a parsing error that would disable owned cleanup.
Wrong deployment binding still rejects. Cleanup remains fenced, revision-conditional
and charged to its original reserve, with no expiry extension or unconditional
fallback. Terminal/expired records and the exception are never reset or deleted.

The report retains the original exception and partial qualification even when
mutable admission evidence changes or the synthetic lifecycle succeeds. Capability
results remain separate. A provider quota refusal can interrupt work and require
independent owner reconciliation; this exception makes no availability or billing
measurement guarantee and retains `hardSpendingCap=false`.

## Verification

Failing-first controls initially rejected honest unknown evidence in TypeScript and
SQL. Additional cap tests reproduced acceptance of impossible required amounts;
those now reject in both validators. Disposable PostgreSQL tests cover each meter,
malformed data, preview replay, direct SQL, immutable singleton reuse/rollback,
known-capacity gates, the 40-request cleanup ceiling and retained prior #55 evidence.
Run `BERTH_TEST_POSTGRES_PORT=your_loopback_port pnpm test:admission-db`, followed
by canonical verification and `pnpm build:live-executor`. Never use these fixtures
against Neon. Complete recovery coverage remains unchanged; #70's owner procedure
continues to use the existing executor and its budgets/expiry.
