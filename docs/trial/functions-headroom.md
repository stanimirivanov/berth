# Neon Free Functions headroom qualification — issue #52

## Decision, 2026-11-15

**No-go for live activation under the current evidence contract.** This completes
the qualification investigation; it does not complete the live trial in #14.
PR #50 remains draft. No provider credentials were read, cloud requests made,
functions deployed, or admission rules changed by this issue.

The owner confirmed Free plans, exclusive Berth use of the Neon project, no other
OCI workloads and the timing of the Console observations in Sofia time. Those
answers resolve the owner questions. Do not ask again for a nonexistent Functions
counter. Exclusive use narrows scope; it does not measure failed loads, scheduler
retries or billed capacity.

Provider documentation rechecked on this date:

- [Consumption metrics](https://neon.com/docs/guides/consumption-metrics) lists
  Launch, Scale, Agent and Enterprise for the Functions-capable consumption API.
  The correctly parameterized read in PR #50 returned 403 on Free.
- [Plans and Functions units](https://neon.com/docs/introduction/plans#functions)
  defines fixed-size runtime hours as capacity-hours, with separate active/waiting
  consumption. Free includes 10 active and 400 waiting capacity-hours and one
  million invocations per project/month. The Console usage summary omits Functions.
- [Trigger delivery](https://neon.com/docs/compute/functions/triggers/overview#delivery-and-retries)
  can retry, duplicate and deliver out of order; retries incur normal usage.
- [Concurrency](https://neon.com/docs/compute/functions/reference/runtime-limits#concurrency)
  is not a strict 100-invocation ceiling. Deployment lifetime multiplied by 100
  cannot establish a hard historical consumption bound.

This is a limitation of the currently documented evidence surfaces, not proof
that no other provider-supported evidence can ever exist. No paid upgrade is an
acceptable way to satisfy this trial.

## Coverage audit

| Activity | Available evidence | Qualification |
| --- | --- | --- |
| Accepted manual calls | Private journals; 23 probe, 12 state-probe intents, 5 checkpoint and 9 executor entries | Partial counts; not billed totals |
| Scheduled calls, retries, overlapping instances | Some observed deliveries, receipts and logs | No complete aggregate |
| Authentication rejection and load failure | Some diagnostic calls and error records | Application ledger does not cover all provider invocations |
| Expired deliveries | Runtime returns before SQL; prior empty function/trigger inventories confirmed | Stops work, not retrospective billing |
| Post-response/platform work | Handler/client measurements, not provider active/waiting totals | No complete capacity measurement |
| Historical log coverage | One executor export explicitly truncated; later export not a complete replacement | Must not infer zero for omitted records |
| Other workloads | Owner says none | Resolves workload scope, not billing visibility |

The existing no-cloud-write probe measured **2,252 ms client elapsed**, **1,547 ms
handler elapsed**, RSS 86,556,672 bytes. See [runtime-evidence.md](runtime-evidence.md).
It proves runtime execution, not real OCI latency or a CPU/wait split. RSS is not
billable capacity. No new probe would recover missing historical billing totals,
so none was deployed merely to make this gate appear satisfied.

## Reproducible forward scenario

`scripts/functions-headroom.ts` is an offline review calculation. It has no I/O,
cloud port or hosted-runtime import, and is never called by live admission.

| Quantity | Scenario value | Meaning |
| --- | --- | --- |
| Application units | 64 | Existing planned application envelope; conservative when paired steps share one HTTP invocation |
| Cleanup reserve | 12 of the 64 | Preserved, not added or consumed by this report |
| Per-call scenario | 60 seconds | At least 20× measured client probe latency; real OCI latency remains unmeasured |
| Extra overhead calls | 32 | Explicit sensitivity assumption for retries/rejections/load failures, not a documented retry cap |
| Administrative tail | 4 calls × 60 seconds; shutdown within 15 minutes after expiry | Assumed owner response window, not automatic provider shutdown |
| Total scenario | (64 + 32 + 4) × 60 = 6,000 capacity-seconds = 1.6667 capacity-hours | Includes cleanup and administrative tail |

The calculation checks all 6,000 seconds against **each** remaining active and
waiting allowance. This avoids claiming a measured CPU/wait split; it is not a
claim both meters actually accrue the entire duration. It also requires capacity
for 100 invocations. For sensitivity, each additional modeled call adds 60 seconds;
each additional 60 calls adds one capacity-hour. An observed client probe above
3,000 ms invalidates the fixed 20×/60-second planning margin instead of silently
increasing the envelope. The current probe is a starting point, not a live-duration
acceptance test.

Postgres CU-hours are a different meter: the owner's 0.33 CU-hours and 100-CU-hour
allowance cannot be used as Functions capacity. A continuously awake 2-CU endpoint
for four hours would use 8 CU-hours before preparation/shutdown activity. Shared
network transfer needs its own aggregate evidence; Functions-only transfer bytes
cannot establish the project's total remaining transfer allowance.

## Evidence input and report semantics

`qualifyFunctions(input, now)` accepts a normalized review record:

- `checkedAt`: provider snapshot's actual as-of Unix milliseconds, not the time an
  old report was reopened. Reject future, missing or older-than-24-hour snapshots.
  Activation additionally needs the existing start-plus-30-minute freshness gate.
- `probe`: `clientMs`, `handlerMs`, and literal `unit: "milliseconds"`.
- `history`: literal `source: "provider-meter"`, `complete: true`,
  `truncated: false`, `unit: "capacity-seconds"`, and `covers` containing
  `accepted`, `rejected`, `load-failure`, `retry`, `expired`, `post-response`.
- Exactly one cumulative billing-period observation: nonsecret `id`, `active` and
  `waiting` capacity-seconds, integer `invocations` and integer `transferBytes`.
  Multiple snapshots are rejected, not summed; this prevents duplicate/overlapping
  cumulative totals. Convert provider microseconds explicitly by dividing by 1e6.

The reviewer must authenticate the original source, project, billing period,
coverage and as-of time before describing it as provider evidence. This module
cannot verify those claims. It accepts no client-log reconstruction as a provider
meter. With valid inputs it returns **review-required**, never go/approved; missing,
truncated, stale, mixed-unit, unsafe numeric or insufficient evidence returns
**no-go**. Invalid evidence yields no remaining-quota figures. Valid-but-insufficient
provider totals can yield negative remaining figures, accompanied by no-go.

All outputs have `admission: false`. They deliberately omit the legacy live
`neonInvocations`, `neonComputeSeconds` and `measuredComputeSeconds` fields. There
is no automatic adapter into admission. Do not copy hypothetical test totals or
scenario estimates into those fields. No SPEC.md or CONSTRAINTS.md exception has
been enacted.

Reproduce the actual evidence limitation without credentials:

```bash
pnpm run build
node --input-type=module <<'JS'
import { qualifyFunctions } from './dist/scripts/functions-headroom.js';
console.log(qualifyFunctions({
  checkedAt: Date.now(),
  probe: { clientMs: 2252, handlerMs: 1547, unit: 'milliseconds' },
  history: { source: 'client-log', complete: false, truncated: true }
}, Date.now()));
JS
```

Expected: `verdict: 'no-go'`, `remaining: null`, `admission: false`. The timestamp
in this reproduction is synthetic; it does not refresh the real account evidence.

## Exact optional contract proposal — not applied

The smallest alternative to waiting for supported provider evidence is to accept
an explicitly uncertain experiment. The following is proposed wording for owner
review, **not** an active exception or a proven conservative historical bound:

> For one four-hour OCI trial on the existing Neon Free project, the owner may
> explicitly accept unverified remaining Functions allowance when the provider
> does not expose its meter on Free. Require owner-attested exclusive project use,
> dated plan and other-service usage evidence, a separately labeled forward
> Functions scenario, the existing application/request/cleanup limits, and owner
> administrative shutdown within fifteen minutes of expiry. Historical Functions
> consumption and provider-visible overhead remain unknown; quota exhaustion may
> prevent hosted cleanup and require manual owned-resource recovery. Such a run
> may establish lifecycle behavior but cannot pass the before/after Functions
> allowance criterion. Record its overall outcome as partial, never an unqualified
> feasibility pass. No paid upgrade, assumed-zero consumption or fabricated numeric
> headroom is permitted.

Accepting that clause would change SPEC.md's unknown-headroom gate and requires an
explicitly reviewed policy/implementation change before use. A future implementation
would need a distinct evidence mode and bounded partial verdict, not a positive
number inserted into the existing numeric schema. This PR **does not implement**
that mode. Merging this qualification report alone does not authorize activation.
Without that explicit exception or complete supported evidence, retain no-go.

## Verification

TDD tests cover unknown/truncated evidence, unit confusion, duplicates, stale and
future snapshots, unsafe numbers, each exhausted meter, exact inclusive reserves,
and immutable cleanup planning. An API test confirms the report cannot replace
configured admission evidence. Passing controls use synthetic provider totals only.
Existing stale/unknown creation rejection and owned cleanup admission remain intact.
No live billing or OCI acceptance is claimed by these local tests.
