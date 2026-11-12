# Restricted OCI trial identity — issue #18

Use the OCI Console for administrator actions, then run the local verifier as the
dedicated trial identity. The script never receives an administrator credential,
changes IAM, creates a bucket/object, or enables a schedule. Live OCI readiness
remains pending until you complete these steps and record the redacted evidence.

Neon database apply/verify succeeded according to the owner's supplied result at
2026-11-12T17:04:05.362Z. OCI is independent of Neon's Ohio region: select the
**OCI tenancy's home region**. The current verifier supports commercial `oc1`
regions known to the pinned OCI SDK, and rejects other realms/regions.

## 1. Check the account and reserve the compartment

As the account owner, record privately:

- Whether the tenancy is Always Free-only, in a promotional trial, or paid.
- The home region shown in tenancy details, and Object Storage namespace.
- Current aggregate Object Storage storage/request consumption and remaining
  Always Free allowance across the tenancy, with a UTC timestamp. A trial credit
  balance does not establish ongoing free eligibility. Include other applications'
  usage and recheck before the live trial.
- Separate Monitoring and Neon allowance headroom. Compartment metrics are not
  tenancy-wide billing evidence, and neither this policy nor the verifier caps
  spending.

Under **Identity & Security → Compartments**, create `berth-trial` under the
tenancy root, with a description identifying this disposable trial. Save its OCID
privately. Keep it empty and reserved against concurrent owner writes. Do not put
existing resources in it, create a bucket yet, or upgrade the tenancy/plan.

## 2. Create a dedicated user and group

In the intended existing identity domain (commonly Default), create:

- User `berth-trial-executor`, for API access only.
- Group `berth-trial-executor`, containing that user.

Use the Console's Users/Groups pages for the selected domain; legacy tenancies
may show those pages directly under Identity. Record the **user OCID** and
**group OCID**, not the domain OCID or display names. Do not create a paid identity
domain for the trial.

Do not add this user to Administrators or domain-administration groups. Inspect
all memberships, including automatically assigned groups such as All Domain
Users. Review applicable tenancy/ancestor/compartment policies and grants to
`any-user`: OCI policies are additive. The narrow policy below cannot cancel a
broader grant. If the identity has broader effective access, resolve that before
using it. Do not remove shared account policies indiscriminately.

The executor needs no IAM user/group/policy administration, compartment creation,
billing access, or tenancy-wide resource enumeration. The account owner performs
setup, reviews aggregate allowance usage, and owns final credential revocation.

## 3. Generate and register a dedicated signing key

Keep secrets outside the checkout, using the same private directory as Neon if
desired. This Linux/macOS example refuses to overwrite existing key files:

```bash
BERTH_PRIVATE_DIR="$HOME/.config/berth-trial"
mkdir -p "$BERTH_PRIVATE_DIR"
chmod 700 "$BERTH_PRIVATE_DIR"
(
  set -euC
  umask 077
  openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 \
    > "$BERTH_PRIVATE_DIR/oci-trial.pem"
  openssl pkey -in "$BERTH_PRIVATE_DIR/oci-trial.pem" -pubout \
    > "$BERTH_PRIVATE_DIR/oci-trial-public.pem"
)
```

In the dedicated user's **API keys** page, choose **Add API key** and upload
`oci-trial-public.pem` only. Record the displayed fingerprint. The Console's
configuration preview identifies the user and tenancy OCIDs; confirm those are
the dedicated user and intended tenancy. Its selected region may differ from the
home region, so check it explicitly.

The private key stays local until the later server-side deployment step. Never
paste it into chat, GitHub, shell arguments or frontend configuration. An encrypted
PEM is also supported: keep its passphrase in a separate owner-only file and use
the optional `passphraseFile` configuration entry. Do not put the passphrase in
JSON itself.

## 4. Prepare the private configuration and policy

Create `$BERTH_PRIVATE_DIR/oci-trial.json` with your editor. Replace the example
values privately; all paths must be absolute. No endpoint override or ambient
`~/.oci/config` fallback is supported.

```json
{
  "tenancyOcid": "ocid1.tenancy.oc1..REPLACE",
  "userOcid": "ocid1.user.oc1..REPLACE",
  "groupOcid": "ocid1.group.oc1..REPLACE",
  "compartmentOcid": "ocid1.compartment.oc1..REPLACE",
  "region": "eu-frankfurt-1",
  "homeRegion": "eu-frankfurt-1",
  "namespace": "REPLACE",
  "fingerprint": "REPLACE_WITH_CONSOLE_FINGERPRINT",
  "privateKeyFile": "/absolute/private/directory/oci-trial.pem"
}
```

Frankfurt above is an example, not a requirement. Set **both** region fields to
your tenancy's actual home region. The script checks consistency, not the truth
of that owner-supplied home-region value. For an encrypted key, add
`"passphraseFile": "/absolute/private/directory/passphrase"`.

```bash
chmod 600 "$BERTH_PRIVATE_DIR/oci-trial.json" "$BERTH_PRIVATE_DIR/oci-trial.pem"
pnpm run setup:oci --config "$BERTH_PRIVATE_DIR/oci-trial.json" --mode plan
```

Plan is offline and does not read the key. Its three policy statements contain
group/compartment OCIDs; keep that output private. As administrator, open
**Identity & Security → Policies**, select the tenancy root, and create policy
`berth-trial-objectstorage` using those statements in the manual editor. Every
grant targets only the dedicated compartment, even though the policy is stored
at the root. No additional `manage object-family` or tenancy-wide grant is needed.

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
pnpm run setup:oci --config "$BERTH_PRIVATE_DIR/oci-trial.json" --mode verify
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
