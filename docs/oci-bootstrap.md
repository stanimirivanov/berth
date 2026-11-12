# Restricted OCI trial identity — issue #18

The administrator setup command creates the dedicated compartment, API-only user,
group, public-key registration and scoped policy in your **existing Default
identity domain**. It does not create a domain, bucket, object or schedule.
The separate verifier uses only the generated trial identity.

Neon database apply/verify succeeded according to the owner's supplied result at
2026-11-12T17:04:05.362Z. OCI is independent of Neon's Ohio region: use the
**OCI tenancy's home region**. Commercial `oc1` regions known to the pinned SDK
are supported. Legacy IAM tenancies and other realms are outside this command.
Live OCI setup remains pending: automated tests use fake responses.

## 1. Prepare the administrator credential and account checks

Use your existing account-owner identity. It needs permission to read tenancy and
domain details, create a compartment and policy at the tenancy root, and administer
users, groups, capabilities and API keys in Default. The tenancy administrator
with the appropriate Identity Domain Administrator access is the intended setup
operator. Domain administration alone does not grant root compartment/policy
creation. Do not give these permissions to the trial executor or automatically
broaden a permission when an API rejects the request.

If you do not already have an administrator API signing key, create one in your
own user's Console **API keys → Add API key** flow. Save its private PEM outside
the repository and record its fingerprint and your **user OCID**. This initial
credential must be established through your existing authenticated account; the
script cannot create its own administrator authority. Never paste keys in chat,
GitHub, command-line arguments or frontend configuration. Revoke a temporary
administrator key after setup and any recovery are complete.

In **Identity & Security → Domains → Default**, copy the **domain OCID**. The
script retrieves its URL using signed IAM requests; no custom endpoint or ambient
`~/.oci/config` fallback is accepted. It requires an active domain under the root.

As owner, also check and record privately:

- Account type: Always Free-only, promotional trial, or paid. Trial credits do not
  establish ongoing free eligibility; do not upgrade a plan for this setup.
- Actual tenancy home region and dated aggregate Object Storage storage/request
  allowance headroom, including other applications' consumption.
- Separate Monitoring and Neon allowance headroom. Compartment metrics are not
  tenancy-wide billing evidence. The script and IAM policy are not spending caps.

## 2. Create the private administrator configuration

Use an owner-only directory outside the checkout. Commands assume Linux/macOS
and the pinned Node/pnpm toolchain:

```bash
BERTH_PRIVATE_DIR="$HOME/.config/berth-trial"
mkdir -p "$BERTH_PRIVATE_DIR"
chmod 700 "$BERTH_PRIVATE_DIR"
```

Using your editor, create `$BERTH_PRIVATE_DIR/oci-admin.json`. Replace these
placeholders privately. `userOcid` and `fingerprint` identify **your administrator**;
the script will generate different trial credentials. Paths must be absolute.

```json
{
  "tenancyOcid": "ocid1.tenancy.oc1..REPLACE",
  "userOcid": "ocid1.user.oc1..REPLACE",
  "domainOcid": "ocid1.domain.oc1..REPLACE",
  "region": "eu-frankfurt-1",
  "fingerprint": "REPLACE_WITH_ADMIN_KEY_FINGERPRINT",
  "privateKeyFile": "/absolute/private/directory/oci-admin.pem",
  "name": "berth-trial"
}
```

Frankfurt is an example; choose your actual home region. For an encrypted admin
PEM, add `"passphraseFile": "/absolute/private/directory/admin-passphrase"`.
The passphrase goes in that file, never in JSON. Protect all input files with
`chmod 600`; symlink files, oversized files and files inside the checkout are
rejected. The output parent must be owned by you, mode 700, outside the repository
and have no symlinks in its path.

```bash
chmod 600 "$BERTH_PRIVATE_DIR/oci-admin.json" "$BERTH_PRIVATE_DIR/oci-admin.pem"
pnpm run setup:oci-admin --config "$BERTH_PRIVATE_DIR/oci-admin.json" --mode plan
```

Plan is offline: it validates configuration and lists the intended operations,
without reading the key or checking actual administrator access. It uses the name
`berth-trial` for the compartment, `berth-trial-executor` for user/group, and
`berth-trial-objectstorage` for the policy. Change `name` if these already exist;
never adopt or overwrite existing resources. Do not run concurrent setups.

## 3. Apply once and retain the recovery journal

The output directory must **not yet exist**:

```bash
BERTH_OCI_RUN="$BERTH_PRIVATE_DIR/oci-bootstrap-01"
pnpm run setup:oci-admin --config "$BERTH_PRIVATE_DIR/oci-admin.json" \
  --output-dir "$BERTH_OCI_RUN" --mode apply
```

Apply checks the admin RSA key/fingerprint, verifies the actual tenancy home
region, resolves the existing domain URL and reads the storage namespace. It then
issues exactly five writes: compartment, service user, group including membership,
public API key, and root policy. The user has API-key capability only; other
credential capabilities and Console access are disabled and must be confirmed in
the response. No password/email, domain administrator role or broad IAM policy is
assigned. Requests are signed with the existing SDK, have 15-second timeouts,
reject redirects and never retry. The happy path is eight requests, including one
Object Storage namespace request. Allow for those requests in account headroom.

The fresh directory contains owner-only files:

- `trial.pem`: generated RSA 3072 private key, unencrypted and protected by mode 600.
- `trial-public.pem`: the corresponding public key registered with the new user.
- `journal.jsonl`: durable intent-before-dispatch records and returned identifiers.
- `oci-trial.json`: generated runtime configuration after all five writes succeed.
  It references the trial key and contains no administrator credential.

Treat the entire directory as private. Keep the key and journal until the trial
identity is revoked and all setup resources are reconciled. The journal contains
identifiers, public-key material and policy text, not private keys/signatures.

**If apply fails or is interrupted, do not retry in a new directory.** An intent
without a confirmed result may have succeeded remotely. Even a confirmed HTTP
response may fail subsequent response checks. Inspect the exact recorded names,
SCIM IDs, OCIDs and fingerprint in the Console, including Audit events, and wait
for propagation/late completion. Resolve every outstanding intent before further
writes. Do not infer absence from one immediate listing. Existing output directories
are deliberately rejected; there is no automatic resume, retry, adoption or rollback.

The owner can finish a partial setup manually using the recorded resources/key
and the three policy statements below, then construct the runtime configuration
using the fields in `scripts/oci-access.ts` (`tenancyOcid`, `userOcid`, `groupOcid`,
`compartmentOcid`, `region`, `homeRegion`, `namespace`, `fingerprint`,
`privateKeyFile`). Alternatively, remove only confirmed dedicated setup resources
in reverse dependency order, verify uncertain operations are settled, and start a
fresh run. Never delete an existing shared identity/policy or the recovery files
while ownership/outcomes remain unresolved. IAM setup recovery is an owner action;
this is separate from the later hosted bucket/object teardown trial.

## 4. Review effective access

Keep the new compartment empty and reserved against concurrent owner writes.
Inspect all executor memberships, including automatic groups such as All Domain
Users, and tenancy/ancestor/compartment policies including grants to `any-user`.
**OCI permissions are additive**: the narrow policy cannot cancel broader grants.
Resolve excessive effective access before using the identity; do not remove shared
account policies indiscriminately. This owner review is not automated.

You can inspect the exact generated policy without reading the signing key:

```bash
pnpm run setup:oci --config "$BERTH_OCI_RUN/oci-trial.json" --mode plan
```

The approved permissions are:

| Resource | Permissions |
| --- | --- |
| Buckets | `BUCKET_INSPECT`, `BUCKET_READ`, `BUCKET_CREATE`, `BUCKET_DELETE` |
| Objects | `OBJECT_INSPECT`, `OBJECT_READ`, `OBJECT_CREATE`, `OBJECT_DELETE` |
| Metrics | Read metrics only in `oci_objectstorage`, within the trial compartment |

Bucket update, retention management/locking, preauthenticated links, replication,
object overwrite and version deletion are omitted. IAM does not enforce one
bucket/object or private-only creation; those are later application checks.
Do not validate denials by attempting a retention lock or mutating unrelated
resources. Inspect the installed policy and all effective grants as owner.

## 5. Run read-only verification

After IAM changes have propagated:

```bash
pnpm run setup:oci --config "$BERTH_OCI_RUN/oci-trial.json" --mode verify
```

The verifier first checks file protections, RSA key strength (at least 2048 bits)
and the public-key fingerprint. It then signs at most three requests using the
dedicated identity:

1. `GetNamespace`, without a compartment parameter; require the expected namespace.
2. `ListBuckets` for the explicit compartment, with limit 1; require an empty
   response and no next-page marker. It does not enumerate other compartments.
3. `SummarizeMetricsData` for `oci_objectstorage` / `StoredBytes`, covering two
   hours at hourly resolution. This API uses POST but is a read operation.

Each request has a 15-second timeout, redirects are rejected, and no retries or
pagination are performed. A failed check stops subsequent requests. Each complete
run consumes two Object Storage requests and one Monitoring request; account for
repeated runs in allowance headroom. The script does not install a scheduler.

Success returns `"readOnlyAccess": "passed"` with a timestamp and request count.
An empty metric response is `"inconclusive-no-metrics"`, not zero usage. Even a
nonempty result is not billing evidence. Report only the redacted result; it
contains no OCIDs, namespace, key paths or signing headers.

If verification fails, check the dedicated identity/key, exact target, installed
policy and propagation as owner. Provider error bodies are not printed. Do not
broaden permissions to make a failing check pass. The namespace, bucket-list and
metric checks cannot prove that writes outside scope are denied, or that future
bucket/object creation/deletion works. Those remain policy-review and gated live
trial checks respectively.

## 6. Record readiness and cleanup responsibility

Record redacted results in [account readiness](trial/account-readiness.md):
verification time, checks passed, owner IAM review, account type/home-region
confirmation and dated aggregate headroom. Keep identifiers and numerical account
details private. Do not close out live readiness based on mocked tests.

Later deployment supplies this identity's secrets only to server-side functions.
The executor must not receive owner API credentials or Angular-accessible secrets.
After the trial, the owner disables/removes schedules, reconciles any remaining
owned resources, revokes the API key, removes deployed credentials, and removes
the dedicated IAM policy/group/user and empty compartment when no longer needed.
Do not delete shared identities/policies or broadly empty a compartment.

Sources: [OCI API signing keys](https://docs.oracle.com/en-us/iaas/Content/API/Concepts/apisigningkey.htm),
[Object Storage permissions](https://docs.oracle.com/en-us/iaas/Content/Identity/Reference/objectstoragepolicyreference.htm),
[Monitoring permissions](https://docs.oracle.com/en-us/iaas/Content/Identity/Reference/monitoringpolicyreference.htm),
[Always Free eligibility](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm),
[Monitoring query parameters](https://docs.oracle.com/en-us/iaas/tools/python/latest/api/monitoring/models/oci.monitoring.models.SummarizeMetricsDataDetails.html).

Administrator API sources:
[Identity Domains request-signature authorization](https://docs.oracle.com/en-us/iaas/Content/Identity/api-getstarted/api-managing-authorization.htm),
[domain user capabilities](https://docs.oracle.com/en-us/iaas/tools/python/latest/api/identity_domains/models/oci.identity_domains.models.ExtensionCapabilitiesUser.html),
[API-key schema and user linkage](https://docs.oracle.com/en-us/iaas/tools/terraform-provider-oci/latest/docs/r/identity_domains_api_key.html).
