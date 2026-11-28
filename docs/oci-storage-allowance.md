# OCI storage allowance

Infrastructure reads the saved tenancy observation from the owner-protected
`/api/inventory/oci-storage` route. Opening or refreshing Infrastructure reads
PostgreSQL through the allowance Function. Only the scheduled collector reads
OCI. The panel shows the reported bytes, source and observation time. When evidence
also qualifies the accounting cutoff, it shows remaining bytes under the
conservative decimal 20 GB Always Free allowance and the warning band. The managed bucket list and the hosting usage panel keep their own data.

## Evidence and limits

- The single OCI signing identity needs `inspect tenancies in tenancy` for
  `ListRegionSubscriptions` and `read resource-availability in tenancy` for
  `GetResourceAvailability`. Use those read capabilities without bucket or
  object permissions for this release. The same identity can receive separately
  reviewed, compartment-scoped lifecycle permissions in a write-enabled release.
- Configure the identity's tenancy OCID, user OCID, home region, key fingerprint
  and RSA private key in the server-only `BERTH_OCI_TENANCY`, `BERTH_OCI_USER`,
  `BERTH_OCI_REGION`, `BERTH_OCI_FINGERPRINT` and `BERTH_OCI_KEY` bindings.
- Set `BERTH_OCI_FREE_PLAN_EVIDENCE` to JSON containing the tenancy OCID
  (`tenancy`), home region (`region`), `plan` set to `always-free-only`, and
  `observedAt` as UTC with millisecond precision. Obtain the plan evidence
  from the owner's OCI Console and verify expired promotional credits and no
  paid upgrade. A generic Free Tier label can also describe a trial. The
  assertion expires after 24 hours. A value from the Limits API cannot establish
  eligibility. [OCI Always Free terms][free] · [OCI account status][billing]
- The collector requires exactly one READY subscription, matching the home
  region. It reads `object-storage/storage-bytes` at the tenancy OCID in that
  region. OCI describes the quota as regional total storage bytes and rolls
  subcompartments into the parent. Root scope includes storage outside Berth.
  OCI documents the integer usage field as rounded up. It also supplies a
  separate quota availability field. The panel measures the Free allowance
  using 20,000,000,000 bytes and the used field. Regional administrative quotas
  can impose additional restrictions. [Quota definition][quota] ·
  [Hierarchy rules][hierarchy] · [SDK response model][response]
- The Limits response's HTTP `Date` establishes when OCI served the observation.
  The collector accepts canonical IMF-fixdate in GMT, including a matching
  weekday, within the inclusive window from 30 seconds before collection started
  through the local observation time. The API exposes no accounting watermark
  or lag guarantee. The collector records the reported bytes with the
  missing-cutoff gap. The panel keeps remaining allowance Unknown and suppresses
  warnings until qualifying evidence is available. Live qualification must
  separately establish acceptable storage and request headroom.
  [HTTP Date format][http-date]
- Retained check #76 used 46,377 bytes and independently found a non-Berth
  Standard bucket of that size in an earlier inventory. The comparison did not
  exercise every tier or multipart accounting. It is the positive transport fixture,
  not current headroom. [Dated issue #76 evidence][historical]
- Missing qualifying evidence gives Unknown when there is no earlier reading.
  Fresh reported-only evidence also shows Unknown headroom. Expiry, failed
  collection, or failed saved read marks retained bytes Stale. The reported
  observation expires at the earlier of two hours after the OCI response time
  and expiry of the plan evidence.

## Collection provenance

The saved response keeps the latest scheduled slot (`attemptedAt`), its
separate last settled outcome (`gap`), and the retained observation (`reading`).
When available, `provenance.lastSettledAttemptAt` identifies the scheduled slot
that produced the settled outcome. `provenance.pending` carries the database
claim time and its deadline for an unsettled latest slot. Deliveries can lag
their scheduled slot, so the deadline starts at the database claim.

The panel labels retained evidence as the previous observation during a pending
collection. A fresh and qualified previous observation may still show its
remaining allowance and warning band. The observation keeps its original cutoff
and expiry. A collection
becomes overdue after ten seconds from claim. This covers the collector's
four-second bound, one second for a new database connection, two queries of up
to 1.5 seconds each during finish, and margin for dispatch and cleanup. Overdue
status marks a retained reading Stale and suppresses headroom and warnings.
The deadline governs the display. A finish can settle only its own latest claim.

Earlier response shapes remain readable. A legacy row settled before upgrade
has a known scheduled slot. A legacy unsettled row has an unknown claim time,
deadline, and last settled slot. The panel displays its collection outcome as
unknown and treats any retained reading as Stale.

## Local verification and release prerequisites

Run `pnpm build:oci-storage` to build the dedicated Neon bundle locally.
Run `pnpm test:oci-storage-db` with `BERTH_TEST_POSTGRES_PORT` set to a fresh
disposable loopback PostgreSQL instance to verify migration and slot admission.
Apply migration 014 for a fresh database and migration 015 for collection
provenance. Migration 014 expects a dedicated `berth_oci_storage_runtime` login
with no granted roles and only grants the scheduled claim, settlement, and
snapshot functions. Migration 015 preserves those grants. Bind `BERTH_OCI_STORAGE_DATABASE_URL`, matching any
injected database URLs, and a dedicated `BERTH_OCI_STORAGE_TOKEN` for the
Function. Pages uses `BERTH_OCI_STORAGE_NEON_ORIGIN` and
`BERTH_OCI_STORAGE_UPSTREAM_TOKEN` with the existing owner access bindings.
Use a distinct upstream token from History and Inventory.

The schedule descriptor is hourly and disabled. Before enabling it in a
separately authorized release, bind its exact ID in `BERTH_OCI_STORAGE_TRIGGER_ID`
and verify that its Neon gateway strips caller-supplied invocation headers.
An authorized slot can make at most two signed OCI GETs within four seconds,
plus bounded database calls. A database claim suppresses duplicate delivery
before OCI dispatch; the collector does not retry, follow redirects, or
traverse pagination. No provisioned-resource write is exposed by the collector.

[http-date]: https://httpwg.org/specs/rfc9110.html#http.date
[free]: https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm
[billing]: https://docs.oracle.com/en-us/iaas/Content/GSG/Concepts/console_topic-AccountCenter-Billing.htm
[quota]: https://docs.oracle.com/en-us/iaas/Content/Quotas/Concepts/resourcequotas_topic-Object_Storage_Quotas.htm
[hierarchy]: https://docs.oracle.com/en-us/iaas/Content/Quotas/Concepts/quota_policy_syntax.htm
[response]: https://github.com/oracle/oci-typescript-sdk/blob/v2.146.0/lib/limits/lib/model/resource-availability.ts#L17-L49
[historical]: https://github.com/stanimirivanov/berth/issues/76#issuecomment-7019614812
