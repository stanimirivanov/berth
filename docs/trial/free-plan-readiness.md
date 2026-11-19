# Free-plan validation readiness — issue #70, 2026-11-19

## Decision

**Offline recovery qualification passes; live activation remains no-go pending a
separate explicit owner decision and fresh account/allowance/IAM evidence.**
The existing November 15 lifecycle remains **failed**, feasibility **partial/no-go**,
and completed owner closeout is unchanged. No new cloud trial was performed.

The milestone keeps Neon/Alchemy/OCI. #68 defines the reviewed Functions evidence
policy; #69 enforces an immutable new-operation authorization without resetting
#55. Missing Functions totals may remain unknown on verified Neon Free under the
owner-accepted interruption/manual-recovery risk. This does not supply a hard cap,
measure remaining Functions allowance or prove its exact exhaustion behavior.

## New offline evidence

`tests/integration/recovery.test.ts` composes the existing local `executeLive` path,
restricted runtime SQL, migrations 001–006, real Alchemy and the pinned OCI SDK.
Every SDK HTTP request is intercepted by `tests/fakes/oci-wire.ts`; there is no
network transport fallback, Functions endpoint or private credential file. RSA key
material is generated in memory solely to construct the signer. SQL runs in a
fresh loopback-only PostgreSQL 17 container. Synthetic owner receipts do not prove
live provider IAM. The initial local invocation creates/uploads the model resources;
subsequent owner invocations use new SQL connections and SDK instances.

| Scenario | Observed result |
| --- | --- |
| Hosting unavailable before cleanup | Owner queues cleanup and reaches terminal resource absence; 15/160 normal, 24/40 cleanup requests |
| Accepted object DELETE loses response | First local step retains needs-reconciliation; fresh invocation resolves the existing deletion and completes teardown; 15/160 normal, 27/40 cleanup requests |
| Unexpected object inventory | No DELETE; bucket/object retained for reconciliation |
| Uncertain upload not observed by the model | Spent unresolved mutation retained; bucket is not deleted on an absence assumption |
| Forty cleanup requests already spent | No additional SDK HTTP sends; resources retained |
| Original window expired | No additional SDK HTTP sends or renewed execution window |
| SQL unavailable | No additional SDK HTTP sends; missing durable ownership evidence blocks recovery |

Success controls send exactly one revision-conditional object DELETE and one
revision-conditional bucket DELETE, retain unknown Functions allowance and a partial
feasibility report, and finish with zero unresolved requests. These counts are real
local SQL reservations, not provider-billed totals. They are examples within the
unchanged ceilings, not new allowance or a promise about live latency/consistency.

The failing-first loss test initially reached succeeded because the model did not
yet drop an accepted DELETE response. A one-shot model fault now deletes the object
and throws before returning its response. The existing production executor recovers
without modification. No production guard, request ceiling, assertion or recovery
boundary was removed. Full crash/security verification remains required in addition
to this focused cross-layer proof.

## Owner procedure and remaining acceptance

[Independent owner cleanup](owner-recovery.md) records exact private inputs, SQL
snapshots, local queue/step commands, stop conditions and hosting/key shutdown. It
requires SQL and ownership evidence; Functions outage and SQL outage are different
failure modes. It neither builds a second executor nor provides an after-expiry
or over-budget deletion bypass. The stopped trial's key/identity must not be reused.

| Capability | Current evidence status |
| --- | --- |
| Hosted bucket creation without initiating computer | Historical live evidence exists; subsequent lifecycle failed |
| Live object upload/read/checksum | Still unproven; offline SDK/SQL success does not replace live evidence |
| Fresh live usage metrics and threshold warning | Still unproven; missing/stale metrics are inconclusive, not zero |
| Controlled missed hosted delivery and recovery | Still unproven live; complete local process-death coverage is separate |
| Autonomous hosted teardown | Still unproven; owner fallback is not autonomous hosted success |
| Functions consumption and remaining allowance | Unknown; no invented numeric headroom or paid telemetry fallback |
| Historical owner closeout | Complete, including deleted dedicated compartment; retained evidence/consumed exception unchanged |

Milestone completion means readiness for a separately reviewed future validation
proposal, not authorization to deploy, recreate IAM, migrate Neon or start a trial.
Any proposal must bind a new operation/window and current evidence, retain 160/40
requests and expiry, plan independent owner availability and shutdown, and report
capability verdicts separately. Unknown Functions allowance keeps overall feasibility
partial even if a future lifecycle succeeds. Missing acceptable billing evidence,
Free status, known allowance headroom or qualified recovery requires documented no-go.

## Reproduce locally

On a fresh disposable loopback PostgreSQL database, run the existing setup fixture
once, then the unfiltered recovery/security suite:

```bash
BERTH_TEST_POSTGRES_PORT=your_loopback_port pnpm test:setup-db
BERTH_TEST_POSTGRES_PORT=your_loopback_port pnpm test:recovery-db
pnpm check:fast
pnpm check
```

Focused diagnosis after `pnpm build`:

```bash
BERTH_TEST_POSTGRES_PORT=your_loopback_port node --test \
  --test-name-pattern='independent owner cleanup|owner recovery refuses' \
  dist/tests/integration/recovery.test.js
```

The focused command supplements the full suite; it is not a replacement for crash
coverage or the four required CI shards. Never point these fixtures at Neon.

## Verification recorded November 19

- Unfiltered `pnpm test:recovery-db`: **158 tests passed**, no failures, skips or
  cancellations; about 399 seconds on the disposable local database. All original
  semantic crash boundaries and the runtime privilege-drift checks were retained.
- Final focused proof: **9 tests passed**, including per-send unique SQL reservation
  checks and retained lost-response reservation settlement as `reconciled-provider`.
  Spent cleanup capacity is monotonic; no reservation is refunded or erased.
- `pnpm check:fast` and `pnpm check`: **168 application / 30 harness tests passed**,
  with formatting/types, verification floor, bundle, secret scan and native high
  audit gate. Seven moderate and one low dependency advisories remain visible.
- All owner shell blocks and the inline Node program passed syntax-only checks;
  CLI shutdown/revocation options were checked with local `--help`. No account
  command was executed, credential file read, cloud resource changed or live trial
  started. No production executor or guard changed in this issue.
