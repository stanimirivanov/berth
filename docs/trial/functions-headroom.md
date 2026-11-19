# Neon Free Functions headroom qualification — issue #52

Current policy: see the [November 19 revision](#revised-policy--issue-68-2026-11-19).
The original qualification and calculator below retain their original semantics;
they are historical evidence, not current live authorization.

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

## Contract proposal and subsequent owner acceptance

The smallest alternative to waiting for supported provider evidence is to accept
an explicitly uncertain experiment. The following wording was proposed in #52
and subsequently accepted by the owner; it is not a conservative historical bound:

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

The owner subsequently accepted this clause for implementation in #55; see
[the exception runbook](free-functions-exception.md). This qualification report
and offline calculator still never grant admission.

Issue #55 implements the distinct owner-prepared evidence mode and partial verdict
under the revised SPEC.md. It does not change this calculator into an admission
source or populate numeric Functions quota. Merging the qualification report alone
did not authorize activation. Without the separately prepared one-use exception
or complete supported evidence, retain no-go.

## Verification

TDD tests cover unknown/truncated evidence, unit confusion, duplicates, stale and
future snapshots, unsafe numbers, each exhausted meter, exact inclusive reserves,
and immutable cleanup planning. An API test confirms the report cannot replace
configured admission evidence. Passing controls use synthetic provider totals only.
Existing stale/unknown creation rejection and owned cleanup admission remain intact.
No live billing or OCI acceptance is claimed by these local tests.

## Revised policy — issue #68, 2026-11-19

**Decision:** retain Neon/Alchemy/OCI initially and permit unknown Functions usage
under the future policy in [SPEC.md](../../SPEC.md#revised-functions-evidence-policy--issue-68-2026-11-19).
The owner accepts execution failure and possible manual OCI recovery, with the
cleanup reserve and independent owner procedure preserved. This replaces the
requirement to find unavailable Functions totals for a future authorized operation;
it does not replace the consumed #55 authorization or alter the failed November 15
trial. Historical feasibility remains partial/no-go; closeout is complete.

### Public provider evidence checked November 19

| Question | Evidence and limitation |
| --- | --- |
| Console totals | [Plans: usage metrics](https://neon.com/docs/introduction/plans#usage-metrics) explicitly omits Functions active/waiting compute and invocations from the usage summary. Database compute is a different meter. |
| API totals | [Consumption metrics](https://neon.com/docs/guides/consumption-metrics) includes Functions in the v2 project/branch endpoints, available on Launch, Scale, Agent and Enterprise, excluding Free. The recorded Free 403 remains historical; no account request was repeated for #68. |
| Billing basis | [Official Free-plan FAQ](https://github.com/neondatabase/website/blob/main/content/faqs/free-plan-limits-and-quotas.md) states no overage billing on Free; [plans](https://neon.com/docs/introduction/plans#price) describes $0/month. This is the policy basis for the products used, not a conclusion from missing card details. No paid add-on or upgrade is included. |
| Exhaustion | The FAQ describes database compute suspension and storage write failures. It does not establish exact monthly Functions exhaustion behavior. Do not infer a Functions response code, shutdown deadline or guaranteed completion from database rules. |

Public documentation establishes available evidence surfaces and billing policy,
not this account's current plan or remaining allowance. Future preparation must
bind authenticated API or dated owner Console plan evidence to the actual project,
period and observation time. Label owner attestation separately from API verification.
Neither an empty display nor exclusive project use establishes consumption totals.

### Future evidence and verdict rules

- Require fresh account/IAM/known allowance evidence through the creation window,
  plus a current substantiated Free billing basis. Stop with a documented no-go for
  missing/stale/unverified plan status, insufficient known allowances or incompatible
  billing behavior. Shared project transfer and Postgres usage remain separate checks.
- If the supported Free interfaces still omit Functions totals, record both usage
  and remaining allowance as unknown. Do not repeatedly search the same unavailable
  counters or upgrade. Available exhausted/insufficient totals block creation.
- Preserve measured scheduling evidence and the forward scenario as estimates;
  retain application metering/warnings without claiming they cover platform retries,
  rejected calls or all billed work. Keep `hardSpendingCap=false`.
- A future run requires a new explicit owner decision and durable operation-bound
  authorization. Preserve old SQL history and the consumed singleton. Independent
  cleanup must be qualified first and cannot spend beyond the original reserve or
  expiry. Unavailable ownership/ledger evidence requires safe reconciliation.
- Report each live capability separately. Successful object lifecycle would not
  prove complete Functions allowance evidence; unknown allowance keeps the overall
  result partial. Offline success cannot pass any remaining live acceptance row.

### Implementation boundary and review

`src/trial/preflight.ts` currently accepts only verified evidence or the historical
`free-functions-one-trial` shape. `src/trial/live-admission.ts` checks the prepared
authorization/version and persisted partial qualification. The SQL gates in
`migrations/004_admission.sql` and `migrations/005_functions_exception.sql` bind
admission and the one-use exception. None implements a new policy mode in #68.
The offline calculator above remains review-only and continues returning no-go
for unsupported historical evidence. Its output must not become an admission input.

[#69](https://github.com/stanimirivanov/berth/issues/69) owns failing-first enforcement
tests across hosted admission, preview replay and direct SQL, including unchanged
cleanup access when creation evidence fails. [#70](https://github.com/stanimirivanov/berth/issues/70)
owns offline independent recovery qualification and exact owner instructions.
Until those reviews and a separate owner authorization, retain no-go for activation.
This documentation-only issue reads no private credentials, performs no live
account checks, changes no schema/code/tests and authorizes no deployment or trial.
