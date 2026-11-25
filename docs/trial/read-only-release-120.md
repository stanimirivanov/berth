# Read-only release qualification — #120, 2026-11-25

**Local rehearsal passed. Hosted release is no-go pending fresh allowance
evidence, shutdown-path confirmation, and separate owner approval.**
The OCI lifecycle verdict remains **partial / no-go**. This qualification made
only read-only account inquiries. It performed no deployment, hosted migration,
OCI provisioning or lifecycle trial.

## Account evidence and decision

Times are UTC. Sofia was UTC+02:00 on this date.

| Check | Dated result | Release disposition |
| --- | --- | --- |
| Neon plan | 01:17, target project and its organization returned HTTP 200 from the management API. The organization reported `free`. | Plan confirmed at observation time. Billing configuration, paid fallback status and known usage headroom still need release-specific evidence. |
| Neon Postgres and network | No fresh complete project/organization usage evidence for the release envelope. Earlier Console snapshots and differently scoped transfer counters are historical. | Obtain fresh compute, storage and network transfer scope, units and period. Reconcile shared transfer against its applicable Free limit before estimating remaining capacity. |
| Neon Functions | Remaining allowance **unknown**. The dated Neon v2 project and organization lookups established plan status. Neither establishes Functions usage. A dated Console check for meters on the target remains pending. | Apply the reviewed interruption-risk policy after the other meters qualify. No numeric estimate is accepted for this check. |
| Cloudflare Workers and Pages | 01:14, the read-only account subscriptions query returned HTTP 401 using the saved credential. Earlier owner observation of Workers Free is historical. | Obtain a fresh Workers Free plan and aggregate current UTC-day request reading. The API denial supplies no evidence about plan or consumption. |
| Retained Inventory coverage | Local fixtures distinguish incomplete coverage from a verified empty result. The target's retained coverage was not inspected. | Record missing evidence per affected offering and how the owner can reconcile it from retained identity-bound records before release. |
| Hosted rollback readiness | No exact production candidate or rollback deployment, owner shutdown access, or current alias list was verified. | Verify these and identify the first-release fallback if there is no prior production build. |

The [release runbook](read-only-release.md) describes the approval gate and
the specific account evidence to collect. Under the reviewed Free-plan
approach, quota exhaustion can interrupt protected reads. The release would
run fail closed, without automatic retries or paid fallback. No shared hard
spending cap is established. The lifecycle exception, original 40 cleanup-only
OCI requests, 12 cleanup application units and
[independent owner cleanup](owner-recovery.md) remain intact.

## Local evidence

Rehearsal started from `5f9ec9c` (merged #168), with the #120 test and docs
applied. The candidate used synthetic credentials, local fixtures and a
disposable PostgreSQL 17 database bound to loopback.

| Check | Result |
| --- | --- |
| `pnpm check` | Passed. 204 backend tests, 51 harness tests, 38 Chromium tests, type and architecture checks, secret scan and the required high-severity package audit gate. |
| `pnpm build:inventory` and bundle smoke check | Passed. Both Function ZIPs passed archive integrity checks. Both built entrypoints denied missing, browser and sibling service credentials before requiring database configuration. |
| Database setup and Inventory integration suites | Passed. Exercised login/grant drift, Inventory role assumption, SQL projection and denied direct private reads and writes. |
| Sequential migration and reader rehearsal | Applied migrations 001–010 locally. The History runtime read the list and details of an expired fixture with the partial verdict. The Inventory runtime returned the bounded projection. Both logins were denied direct ledger reads and writes. History still uses the shared `berth_runtime` identity with retained executor grants. Its read-only transaction and bounded query path are the tested boundary. |
| Pages and upstream access rollback fixture | Both real Pages entrypoints accepted the same browser credential and rejected a foreign origin. Both real upstream handlers rejected the other service's token. After simulated service token rotation, the old direct service token was denied and the old Pages binding returned an uncached 503. The old browser credential was denied after rotation. The same retained fixture was available with renewed browser and service credentials. |

Hosted DNS/routing, real bindings, live SQL role grants, quota behavior and
the Cloudflare production rollback action remain pending. No local fixture
establishes these hosted results. Repeat the work in
[the hosted checklist](read-only-release.md#smoke-test-after-separate-approval)
only after the evidence and approval gates pass.
