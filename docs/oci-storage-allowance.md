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
- The Limits response's HTTP date establishes when OCI served the current-usage
  observation. The API exposes no accounting watermark or lag guarantee.
  The collector records the observed bytes with the missing-cutoff gap. The
  panel keeps remaining allowance Unknown and suppresses warnings for this
  observation until qualifying evidence is available. Live qualification must
  separately establish acceptable storage and request headroom. There is no
  conversion from accumulated GB-months to current stored bytes.
- Retained check #76 used 46,377 bytes and independently found a non-Berth
  Standard bucket of that size in an earlier inventory. The comparison did not
  exercise every tier or multipart accounting. It is the positive transport fixture,
  not current headroom. [Dated issue #76 evidence][historical]
- Multiple subscribed regions, incomplete data, missing timestamps, or an
  expired account assertion give Unknown when there is no earlier reading.
  A failed refresh preserves the earlier observation as Stale. A successful
  reading expires at the earlier of two hours after the provider date and
  expiry of the plan evidence.

## Local verification and release prerequisites

Run `pnpm build:oci-storage` to build the dedicated Neon bundle locally.
Run `pnpm test:oci-storage-db` with `BERTH_TEST_POSTGRES_PORT` set to a fresh
disposable loopback PostgreSQL instance to verify migration and slot admission.
Migration 014 expects a dedicated `berth_oci_storage_runtime` login with no
granted roles. The migration only grants the scheduled claim, settlement, and
snapshot functions. Bind `BERTH_OCI_STORAGE_DATABASE_URL`, matching any
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

[free]: https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm
[billing]: https://docs.oracle.com/en-us/iaas/Content/GSG/Concepts/console_topic-AccountCenter-Billing.htm
[quota]: https://docs.oracle.com/en-us/iaas/Content/Quotas/Concepts/resourcequotas_topic-Object_Storage_Quotas.htm
[hierarchy]: https://docs.oracle.com/en-us/iaas/Content/Quotas/Concepts/quota_policy_syntax.htm
[response]: https://github.com/oracle/oci-typescript-sdk/blob/v2.146.0/lib/limits/lib/model/resource-availability.ts#L17-L49
[historical]: https://github.com/stanimirivanov/berth/issues/76#issuecomment-7019614812
