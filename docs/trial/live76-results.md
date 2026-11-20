# Bounded hosted OCI validation — issue #76, November 20, 2026

**Stopped — needs-reconciliation; partial / no-go.** Hosting is removed, but the
PUT outcome remains unresolved, the bucket is not proven removed, and the restricted
key remains active for reconciliation. **26/40 cleanup requests remain.** Original
cloud-work expiry is **12:50 Sofia on November 20**; no new trial is authorized.

## Scope and retained verdict

The owner authorized one **one-hour partial experiment**, accepting that fresh
usage metrics and missed-delivery recovery may remain unproven and a provider
outage could require later independent cleanup. This operation is separate from
the November 15 failed lifecycle; its failed / partial-no-go verdict and completed
closeout are preserved. Unknown Functions allowance and the approved five-meter
exception keep overall feasibility **partial**, with `hardSpendingCap=false`.

The fixed runtime window is **06:50–10:50 UTC / 08:50–12:50 Sofia**. The narrower
operational targets are cleanup requested by **07:10 / 09:10**, owner fallback by
**07:30 / 09:30** if needed, and hosting shutdown by **07:50 / 09:50**. The fixed
expiry was not shortened or renewed. No second operation is authorized.

All limits remain unchanged: 160 normal / **40 exclusively cleanup** OCI requests,
20 Monitoring calls, 64 application units including **12 cleanup**, three attempts
per action, minute-30 creation cutoff, hour-three cleanup and hour-four cloud-work
stop. Early cancellation does not increase a reserve or refund spent requests.

## Release and preparation evidence

- Source: `d2ea1292f0343af4cb487560f2bc070656971e11`, including merged PR #79.
- Uploaded ZIP: 376,806 bytes, SHA-256
  `9ab4ee1383a1a3533068835efdd9d2a88f8e710731f242fdbc6ac5856950e0a7`.
- Canonical `pnpm check`, separate fast checks and live bundle build passed before
  preparation: 168 application / 30 harness tests, secret scan and high-severity
  audit gate; seven moderate and one low dependency findings remain visible.
- Retained release qualification includes 12 admission and all 158 recovery/security
  tests from PR #79. They are offline qualification, not this live result.
- Migrations 006/007 were installed in the prior separately authorized preparation.
  The new singleton was empty before this operation and is consumed once. The old
  singleton and historical counters remain unchanged; no schema or state reset.
- Refreshed Neon organization is Free, Ohio target matches, one project/branch and
  one endpoint configured up to 2 CU; hosting inventories were empty. The project
  list's returned cursor was followed once to an empty continuation page.
- Known Postgres capacity uses current sole-branch logical size 33,013,760 bytes
  against a conservative 1,000,000,000-byte ceiling, with an additional 64 MiB
  deduction; reviewed whole-operation storage requirement is another 64 MiB.
  Compute capacity conservatively subtracts the owner's dated 0.54 CU-hours and
  **2 CU for every elapsed second** since that observation from 100 CU-hours.
  Required compute is 34,200 CU-seconds, including preparation/shutdown margin.
  The API's lagged raw CPU-second counter is not substituted for CU-hours.
- OCI home region and active new compartment verified; available storage is above
  10 MiB after applying the conservative documented Free storage ceiling. Complete
  group/policy inventories confirm only the dedicated restricted group applies.
  The unrelated root bucket/object and administrator credentials are untouched.
- The five allowed incomplete meters retain raw units/source/time and unknown
  remaining capacity. Observations: Neon project proxy egress 2,209,381 bytes;
  OCI requests 0.0090 × 10K Requests; retrieval 0.07992 Million Datapoints;
  outbound 0.000013531182 GB Months; ingestion not exposed. No ambiguous outbound
  unit was converted, and missing consumption was not treated as zero.
- Owner SQL cleanup access passed. The privately retained fallback uses the same
  fenced executor and its original budgets/window; it cannot delete by name,
  bypass missing SQL evidence, or turn owner fallback into hosted success.

Raw evidence, operation identity, credentials and journals remain owner-only under
`~/.config/berth-trial/live76-01/`; identifiers and secrets are omitted here.

## Admission and execution

- The single deployment POST was accepted; a read confirmed that exact deployment
  active/completed. Neon returns environment **names**, not values, on GET. All 21
  expected names matched; hosted admission subsequently exercised the actual SQL
  credential guard and restricted OCI signing credential. No owner SQL or Neon
  management credential was sent as a runtime environment value.
- Missing bearer and a manual bearer request to `/scheduled` returned HTTP 401.
  No forged gateway header was sent to the armed live function. Existing synthetic
  gateway-stripping evidence remains the prerequisite for the same deployment path.
- `/preview` returned HTTP 200 and exactly matched the reviewed private Standard
  bucket, disabled auto-tiering/versioning and 1 MiB object proposal. It consumed
  the metered credential checks; it is not described as persistence-free.
- `/submit` returned HTTP 202 for the same operation and partial feasibility. The
  initiating HTTP client exited. No local lifecycle step was used for creation.

## Observed result and shutdown

**Stopped with `needs-reconciliation`; no-go for a successful lifecycle verdict.**
The consumed operation remains open in SQL, with one unresolved mutating
`put_object` reservation and four open attempts. Neither hosted cleanup nor the
one owner fallback established safe removal. No deletion attempt was recorded;
resource absence and empty engine state are **not** claimed.

| UTC / Sofia | Observation |
| --- | --- |
| 06:50:22 / 08:50:22 | Missing bearer and manual scheduled bearer requests returned 401 |
| 06:50:24 / 08:50:24 | Exact preview accepted; 1,452 ms client elapsed |
| 06:50:33 / 08:50:33 | Submission accepted, HTTP 202 |
| 07:00:01–07:00:04 / 09:00:01–09:00:04 | Hosted delivery used two persisted subdeliveries; bucket creation settled successfully; PUT remained unresolved, pending upload true, no receipt; phase moved to cleanup/reconciliation |
| 07:01–07:02 / 09:01–09:02 | Node fetch and documented bodyless curl cleanup requests both returned 400 `body-not-allowed`; SQL proved neither changed cancellation or spent its control unit |
| 07:03:56 / 09:03:56 | Prepared owner **SQL-only** cleanup control queued cancellation; no local provider lifecycle step |
| 07:15:02–07:15:04 / 09:15:02–09:15:04 | Next hosted delivery spent seven protected inspection requests and stopped, preserving unresolved PUT and ownership evidence |
| 07:16 / 09:16 | Trigger disabled and authenticated GET confirmed disabled |
| 07:16:40–07:16:55 / 09:16:40–09:16:55 | Fresh SQL snapshot, then exactly one existing fenced **owner** cleanup step; seven more protected inspections, same unresolved outcome, no DELETE |
| 07:18:28 / 09:18:28 | Trigger and function deleted; authenticated inventories empty, with no continuation; SQL retained the same unresolved state |

The initiating HTTP client was closed between submission and the 07:00 schedule;
no local lifecycle call created the bucket or attempted upload. The later local
fallback is explicitly separate from hosted execution. This is not proof the
computer was physically powered off, nor a successful autonomous full journey.

### Resource and credential handoff

- The created bucket has **no recorded deletion** and must be treated as remaining.
  The object upload has no definitive outcome or verified checksum receipt. Empty
  inventory or missing audit evidence cannot settle an uncertain mutation.
- Alchemy state is retained, pending upload true, object removal false. Four open
  attempts remain: inspection, invocation, PUT and cleanup inspection. No counter,
  attempt, marker, revision, evidence row or timestamp was edited to conceal this.
- The dedicated trial API key is deliberately **retained and active** for independent
  reconciliation. It was not revoked on an unproved resource-absence assumption.
  Hosting deletion removed deployed runtime secrets; private recovery inputs remain
  owner-only. The administrator key and unrelated resources remain unchanged.
- Original cloud-work expiry remains **10:50 UTC / 12:50 Sofia on November 20**.
  Any further work needs a reviewed reconciliation decision using the saved
  ownership/dispatch evidence and remaining reserve. After expiry, the executor
  must not perform cloud work; after-expiry or extra-budget action requires a
  separate explicit owner decision. This report grants neither and does not
  authorize another trial.

### Final application accounting

| Meter | Reserved / maximum | Remaining |
| --- | --- | --- |
| Normal Object Storage | 15 / 160 | 145 |
| Protected cleanup Object Storage | 14 / 40 | **26** |
| Monitoring calls | 0 / 20 | 20 |
| Application units | 7 / 64 | 57 total; existing protected-slice rules unchanged |

The 33 request rows comprise 29 Object Storage reservations and four invocation
reservations. Thirty-two are settled and one PUT remains unresolved. Three HTTP
receipts account for preview, submit and the local cleanup control; the rejected
bodyless controls never reached SQL. Local fallback/control units are conservatively
charged. Post-shutdown API observations are project proxy transfer **2,240,411 bytes**,
branch proxy transfer **1,802,430 bytes**, and unchanged raw project compute
**2,317 CPU-seconds**. Their scopes/freshness differ and can lag; unchanged compute
is not zero consumption. No complete Functions/shared-transfer billing delta or
numeric remaining allowance is inferred from them.

These application units are **not provider-billed Functions totals**;
rejected calls, management reads, logs and platform activity have separate incomplete
coverage. No reservation was refunded and no reserve expanded.

### Capability verdicts and follow-ups

| Capability | Result |
| --- | --- |
| Hosted Neon/Alchemy bucket creation after initiating client exits | Verified; separate scheduled delivery settled creation |
| Durable continuation across scheduled deliveries | Verified; later hosted delivery loaded prior bucket/pending-upload state |
| Live object upload/read/checksum | Unproven; unresolved PUT and no receipt |
| Fresh usage metrics / deduplicated threshold warning | Unproven; observation phase was never reached, zero application Monitoring requests |
| Controlled missed delivery / recovery | Not attempted; shortened scope and failure required cleanup |
| Autonomous conditional teardown | Unproven; hosted attempt stopped safely without deletion |
| Independent owner cleanup | Access and fencing exercised, but removal unproven; fallback also stopped safely |
| Hosting shutdown | Verified before one-hour target; zero functions and triggers |
| Complete resource/IAM closeout | Incomplete; remaining bucket, unresolved upload and active restricted key retained |
| Overall feasibility | **Partial / no-go**, independently of every capability row |

[Issue #80](https://github.com/stanimirivanov/berth/issues/80) owns the confirmed
empty-stream/bodyless-control admission defect. The handler checks body presence;
actual zero-byte POST controls were rejected before protected work. Fix it with
bounded byte inspection and TDD, retaining payload/authentication guards.

[Issue #81](https://github.com/stanimirivanov/berth/issues/81) owns the hosted PUT
failure investigation and safe diagnostics/bundled-transport regression. The
reservation and released lease are about 19 ms apart, a clue rather than proof of
non-dispatch. The bounded function-log query returned 22 records without truncation
and no underlying error category; an exact credential-string scan found no matches.
OCI Audit confirmed bucket creation but did not resolve PUT. No guessed root cause,
absence-based settlement, upload replay or in-flight code change was performed.

Issue #76 remains open because live acceptance criteria and closeout are incomplete.
The prior November 15 failed/partial verdict and its completed owner cleanup are
unchanged; this operation's leftover state is a separate handoff.
