# Set up the restricted OCI trial identity

Follow this guide in order. It targets your existing **Default** identity domain
and the administrator setup delivered in #18 / PR #19.

| You do manually | The script does for you |
| --- | --- |
| Sign in as the existing tenancy administrator; copy account IDs; register an administrator API key; fill one JSON file | Create `berth-trial` compartment, `berth-trial-executor` user and group, a separate trial signing key, and `berth-trial-objectstorage` policy |
| Review effective permissions and allowance headroom after setup | Generate the trial configuration and run bounded read-only checks when requested |

**Do not open Create user, Create group, Create compartment or Create policy forms
for the normal setup.** Those resources are created by `--mode apply`. No bucket,
object, new identity domain, hosted deployment or schedule is created.

Console labels below were checked against Oracle documentation on 2026-11-12,
not against your signed-in Console. Where Oracle documents both layouts, both
paths are listed. If neither path matches, stop at that step and report the screen
title and visible labels; do not substitute another credential type.

## 1. Open the right account and prepare your terminal

- Open [OCI Console](https://cloud.oracle.com/) and sign in to your existing tenancy.
- At the identity-domain choice, select **Default** and use your existing
  tenancy-administrator account, normally the initial account owner.
- This account needs both tenancy administration (root compartment/policy creation)
  and user/group/key administration in Default. A domain-only administrator is not
  sufficient. Do not assign administrator roles to the new trial user.
- Use your local Bash terminal, not OCI Cloud Shell. Keep this terminal open so the
  variables below remain available.

Run from the `berth` checkout:

```bash
cd "$HOME/sources/infra-as-code/berth"
node --version
pnpm --version
BERTH_PRIVATE_DIR="$HOME/.config/berth-trial"
mkdir -p "$BERTH_PRIVATE_DIR"
chmod 700 "$BERTH_PRIVATE_DIR"
```

Expected versions: Node `v24.22.3`, pnpm `12.16.1`. If your checkout is elsewhere,
change only the `cd` path. The private directory must be outside the checkout,
owned by you and not reached through a symlink. Keep all keys and JSON files out
of chat, Git and GitHub.

## 2. Collect the tenancy, home region and domain values

Keep the copied values in a private local note until step 4.

### A. Tenancy OCID

- Open the **Profile** menu in the Console's top navigation bar.
- Select **Tenancy: _your-tenancy-name_**.
- On **Tenancy details**, find **Tenancy information → OCID** and select **Copy**.
- Save this as `tenancyOcid`; it starts with `ocid1.tenancy.`.
- Do not copy the tenancy name into this field.

### B. Home region

- Open the **Regions** menu in the top navigation bar.
- Note the region marked **Home region**. If necessary, select **Manage regions**
  to see the home-region label.
- Select that home region in the region selector for the remaining Console steps.
- Convert its display name to the **Region identifier** in Oracle's
  [region table](https://docs.oracle.com/en-us/iaas/Content/General/Concepts/regions.htm).
- Save the identifier as `region`, for example `eu-frankfurt-1` for Germany Central
  (Frankfurt), or `us-ashburn-1` for US East (Ashburn).
- Do not use a display name, region key such as `FRA`, or Neon's `aws-us-east-2`.
  Neon's Ohio location does not determine the OCI region.

### C. Default domain OCID

- Open **☰ Navigation menu → Identity & Security → Identity → Domains**.
- Set the **Compartment** filter to your tenancy's **root** compartment.
- Select **Default** in the domain list. Do not select **Create domain**.
- On the domain details page, check **Status: Active** and the expected **Home region**.
- Next to **OCID**, select **Copy**. Save it as `domainOcid`; it starts with
  `ocid1.domain.`.
- Leave **Domain URL**, **Regional URL**, replication and disaster-recovery settings
  unchanged. None of those values belong in the JSON file.

Sources: [tenancy/user OCIDs](https://docs.oracle.com/en-us/iaas/Content/API/Concepts/apisigningkey.htm),
[Default domain](https://docs.oracle.com/en-us/iaas/Content/Identity/domains/the_default_domain.htm),
[domain details](https://docs.oracle.com/en-us/iaas/Content/Identity/domains/to-view-details-of-an-identity-domain.htm).

## 3. Register an API key for your administrator

This key authorizes the one-time setup. The script later generates a **different**
key for the restricted executor. The following path creates a dedicated setup key;
if you already have a suitable administrator key, reuse its private path and
fingerprint in step 4 instead, without registering it again.

### A. Generate the key locally

Run this block once. It refuses to overwrite either existing file:

```bash
(
  set -euC
  umask 077
  openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 \
    > "$BERTH_PRIVATE_DIR/oci-admin.pem"
  openssl pkey -in "$BERTH_PRIVATE_DIR/oci-admin.pem" -pubout \
    > "$BERTH_PRIVATE_DIR/oci-admin-public.pem"
)
```

- Expected: both `.pem` files exist; OpenSSL may print key-generation progress.
- This path creates an unencrypted private key protected by file permissions.
  It does not ask for a passphrase; omit `passphraseFile` in step 4.
- If either file already exists, stop. Do not delete or overwrite it blindly.
  Determine whether it is the key you already registered.

### B. Open your user and upload only the public key

- Open **Profile → User settings**. Check that the displayed user is your existing
  administrator, not `berth-trial-executor`.
- Copy the **OCID** from **User information** and save it as `userOcid`.
  It starts with `ocid1.user.`. Do not use an email address or SCIM user ID.
- Open **Tokens and keys → API keys**. In the older layout, use
  **Resources → API Keys** instead.
- Select **Add API key**.

Fill the dialog as follows:

| Control | What to do |
| --- | --- |
| Key option | Select **Paste a public key** (older label: **Paste Public Key**) |
| Public-key text box | Paste the entire contents of `oci-admin-public.pem`, including `BEGIN PUBLIC KEY` and `END PUBLIC KEY` lines |
| Generate API key pair / Choose Public Key File | Leave unselected for this path |
| Other optional fields, if shown | Leave blank/default; this step does not require a password, token or secret key |
| Submit | Select **Add** |

To display the public key for copying:

```bash
cat "$BERTH_PRIVATE_DIR/oci-admin-public.pem"
```

**Never paste `oci-admin.pem`: that is the private key.** If OCI reports the
three-key limit, use an existing suitable key or identify an unused key with the
owner; do not delete a working key to make room.

### C. Copy the fingerprint

- In **Configuration file preview**, copy the value after `fingerprint=`.
- Save only the colon-separated fingerprint as `fingerprint`; omit the field name.
- The preview's `user=` and `tenancy=` should match the OCIDs already collected.
- Ignore its `region=` if it is not your home region.
- Do not copy `[DEFAULT]` or the INI snippet into the JSON file. No `~/.oci/config`
  file is needed by these scripts.
- Close the preview. To find it again, use the API-key row's **⋯ → View
  configuration file** action.

Sources: [API keys and OCIDs](https://docs.oracle.com/en-us/iaas/Content/API/Concepts/apisigningkey.htm),
[new Console key panel and preview](https://docs.oracle.com/en-us/iaas/Content/Functions/Tasks/functionsquickstart_codeonly_localhost.htm).

## 4. Fill in the administrator JSON file

Create the file privately, then open it in your editor:

```bash
(umask 077; touch "$BERTH_PRIVATE_DIR/oci-admin.json")
chmod 600 "$BERTH_PRIVATE_DIR/oci-admin.json" "$BERTH_PRIVATE_DIR/oci-admin.pem"
nano "$BERTH_PRIVATE_DIR/oci-admin.json"
```

Paste this template and replace every `REPLACE_...` value. JSON requires double
quotes and no comments or trailing commas.

```json
{
  "tenancyOcid": "REPLACE_TENANCY_OCID",
  "userOcid": "REPLACE_ADMIN_USER_OCID",
  "domainOcid": "REPLACE_DEFAULT_DOMAIN_OCID",
  "region": "REPLACE_HOME_REGION_IDENTIFIER",
  "fingerprint": "REPLACE_ADMIN_KEY_FINGERPRINT",
  "privateKeyFile": "REPLACE_ABSOLUTE_ADMIN_PRIVATE_KEY_PATH",
  "name": "berth-trial"
}
```

| JSON field | Exact input |
| --- | --- |
| `tenancyOcid` | Full OCID copied in step 2A |
| `userOcid` | Existing administrator's full OCID from step 3B |
| `domainOcid` | Default domain's full OCID from step 2C |
| `region` | Home-region identifier from step 2B, e.g. `eu-frankfurt-1` |
| `fingerprint` | Administrator key fingerprint from step 3C, lowercase colon-separated hex |
| `privateKeyFile` | Absolute path to `oci-admin.pem`, not the public file; e.g. `/home/izanagi/.config/berth-trial/oci-admin.pem` |
| `name` | Keep `berth-trial` for a fresh setup; if already used, resolve the previous setup before choosing another name |
| `passphraseFile` | **Omit the property entirely** for the key generated above; do not add an empty string or `null` |

- No required field may be blank.
- Do not put `~`, `$HOME` or `$BERTH_PRIVATE_DIR` inside JSON paths: JSON does not
  expand shell variables. `printf '%s\n' "$BERTH_PRIVATE_DIR/oci-admin.pem"` shows
  the absolute path to copy.
- Do not add namespace, group/compartment IDs, key contents, passwords, endpoints
  or `homeRegion`: the administrator parser does not accept those fields.
- In nano: **Ctrl+O**, **Enter** to save; **Ctrl+X** to exit.
- If reusing an encrypted key, add `passphraseFile` with an absolute path to a
  separate mode-600 file containing its passphrase. Never put the passphrase itself
  in JSON or a shell argument. Use your editor to populate that file privately.

## 5. Review the offline plan, then apply once

### A. Plan

```bash
pnpm run setup:oci-admin --config "$BERTH_PRIVATE_DIR/oci-admin.json" --mode plan
```

Check that the output contains:

- `"mode": "plan"`.
- `"name": "berth-trial"` and your actual home-region identifier.
- Actions to create a compartment, service user/group, key registration and scoped policy.

Plan makes no network requests and does not read the key. Success here does not
prove that the administrator key or permissions work.

### B. Apply

Do **not** create the output directory yourself. Choose the path and run:

```bash
BERTH_OCI_RUN="$BERTH_PRIVATE_DIR/oci-bootstrap-01"
pnpm run setup:oci-admin --config "$BERTH_PRIVATE_DIR/oci-admin.json" \
  --output-dir "$BERTH_OCI_RUN" --mode apply
```

Expected success: `"administratorSetup": "created"`, `"iamWrites": 5`.

| Created item | Value chosen by the script; no Console form to fill |
| --- | --- |
| Compartment | `berth-trial`, parent = tenancy root |
| User in Default | `berth-trial-executor`; service user; API keys enabled; Console and other credential capabilities disabled; no password/email supplied |
| Group in Default | `berth-trial-executor`, containing that new user |
| Trial API key | New RSA 3072 key; only its public part uploaded to the new user |
| Policy at root | `berth-trial-objectstorage`; three statements limited to the trial compartment |

The output directory contains `trial.pem`, `trial-public.pem`, `journal.jsonl`
and, after success, `oci-trial.json`. Keep them private. The runtime JSON references
only the trial key, not your administrator credential.

**On any error or interruption, go to [Recovery](#recovery-if-apply-fails). Do not
rerun apply with another output directory.**

## 6. Review the created permissions in the Console

First print the expected policy locally:

```bash
pnpm run setup:oci --config "$BERTH_OCI_RUN/oci-trial.json" --mode plan
```

This output contains private identifiers; do not paste it into an issue.

- Open **☰ → Identity & Security → Identity → Policies**.
- Set **Compartment** (older layout: **List scope → Compartment**) to the tenancy root.
- Select **berth-trial-objectstorage**. Compare its **Statements** with the three
  generated statements. Leave the policy unchanged.
- Expected permissions:

| Target | Allowed operations |
| --- | --- |
| Buckets in the trial compartment | `BUCKET_INSPECT`, `BUCKET_READ`, `BUCKET_CREATE`, `BUCKET_DELETE` |
| Objects in the trial compartment | `OBJECT_INSPECT`, `OBJECT_READ`, `OBJECT_CREATE`, `OBJECT_DELETE` |
| Metrics in the trial compartment | Read only namespace `oci_objectstorage` |

Then review all effective grants, not just this policy:

- Open **☰ → Identity & Security → Identity → Domains → Default**.
- Select **User management**, then the **Users** section. In the older layout,
  select **Users** under **Identity domain** in the left sidebar. Later references
  to **Default → Users** mean this same path; **Default → Groups** similarly uses
  the Groups section/link.
- Select **berth-trial-executor**, then **Groups** (a tab or resource link).
- Confirm membership in **berth-trial-executor**, and inspect any additional groups,
  including automatically assigned **All Domain Users**. The user must not be an
  administrator or belong to **Administrators**.
- Return to **Policies**, select the root compartment, and inspect statements in
  every policy for grants to those groups (by name or OCID) or `any-user`.
- Repeat the policy review with **Compartment = berth-trial**. This compartment is
  directly below root, so there are no intermediate ancestor compartments.
- Stop if any applicable statement grants broader access. Record the policy name
  and statement privately for review; do not delete shared policies or silently
  add permissions to make verification pass.

OCI grants are additive: the new policy cannot revoke broader access. There is no
single effective-access verdict produced by this script. IAM also does not enforce
one bucket/object, private-only creation or a hard spending cap. Do not test denials
by attempting retention locks or writes to unrelated resources.

Sources: [domain user navigation](https://docs.oracle.com/en-us/iaas/Content/Identity/users/view-user-account.htm),
[finding policies and their statements](https://docs.oracle.com/en-us/iaas/Content/Security/Reference/configuration_tasks.htm).

## 7. Run read-only verification

Once the created user/group/policy are visible and the owner review above is complete:

```bash
pnpm run setup:oci --config "$BERTH_OCI_RUN/oci-trial.json" --mode verify
```

Expected output:

- `readOnlyAccess`: `passed`.
- `requestsDispatched`: `3`.
- `checks.namespace`: `verified`.
- `checks.compartmentEmpty`: `verified`.
- `checks.monitoringQuery`: `accepted`.
- `usageEvidence`: either `inconclusive-no-metrics` or
  `metrics-present-not-billing-evidence`. Neither proves zero usage or zero charges.

If verification fails:

- Check the operation/status printed by the command. Inspect the matching user,
  key fingerprint, compartment and policy in the Console using step 6.
- If the only issue is IAM propagation, allow time for propagation before another
  **verify** run. Do not rerun **apply** and do not broaden the policy.
- A nonempty compartment must be investigated; do not broadly delete its contents.
- Keep live bucket/object permission tests pending until the gated trial.

## 8. Check allowance headroom and record readiness

These owner checks are separate from the API-access test:

- Open **☰ → Billing & Cost Management → Billing → Subscriptions**.
- Open your **Infrastructure** subscription and record its displayed plan/type and
  any trial-credit expiry privately. Do not select an upgrade/purchase action.
- Open **☰ → Billing & Cost Management → Cost Management → Cost Analysis**.
- Configure the query before reading the chart:

| Cost Analysis control | Selection |
| --- | --- |
| **Start/End Date (UTC)** | Start of the current billing period through the latest available date |
| **Show** | **Usage**, not the default **Cost** |
| **Show Forecast** | Leave unchecked |
| **Cumulative** | Leave unchecked so you can distinguish each time interval |
| **Filters** | Add **Service** and select the Object Storage service entry shown in your tenancy; leave compartment, region, tag and resource filters unset |
| **Grouping Dimensions** | **Service and Product Description**, to distinguish storage and request meters |

- In the Service filter dialog, select **Select**. Then select **Apply** to refresh
  the chart and the table beneath it.
- Inspect each meter's quantity and unit; do not add storage and request units
  together. Do not treat accumulated storage-time units as current stored bytes.
  Compare the reported consumption
  with the current [Always Free allowances](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm).
  A zero-cost chart or promotional credit balance is not proof of unused allowance.
- Record the UTC check time, storage/request allowance headroom and other workloads
  using that allowance in your private note. Record Monitoring and Neon headroom
  separately. If the Console does not expose sufficient consumption data, mark
  headroom **unverified** rather than assume zero usage; keep the live trial blocked.
- Recheck headroom immediately before the live bucket/object trial. Billing/usage
  data can lag; these checks are not a hard spending cap or an implemented warning
  scheduler.
- Update [account readiness](trial/account-readiness.md) with only redacted outcomes:
  verification timestamp, passed checks, effective-IAM review status, account type,
  confirmed home-region eligibility and whether dated headroom was established.

Sources: [Subscriptions](https://docs.oracle.com/en-us/iaas/Content/Billing/Concepts/subscriptions.htm),
[Cost Analysis](https://docs.oracle.com/en-us/iaas/Content/Billing/Concepts/costanalysisoverview.htm).

## Recovery if apply fails

For the recorded `oci-bootstrap-02` run (confirmed compartment, HTTP 400 at user
creation, no later writes), use the [specific recovery command](trial/oci-create-user-recovery.md).
It validates and reuses the original compartment/key. The steps below apply to
other failures and to any failure after recovery has started.

1. Keep the output directory, keys and `journal.jsonl`. Open the journal locally in
   your editor. Never post it publicly.
2. Find the last `operation` and its `phase`. `intent` means a write was about to be
   sent; without `confirmed`, its outcome is unknown. A confirmed HTTP response can
   still fail later validation. Neither condition authorizes a repeat creation.
3. Locate each recorded resource using this table. Compare the returned OCID/SCIM
   ID and fingerprint where available, not just the display name.

| Journal operation | Console location / lookup |
| --- | --- |
| `CreateCompartment` | **☰ → Identity & Security → Identity → Compartments**; locate `berth-trial` under root |
| `CreateUser` | **Domains → Default → Users → berth-trial-executor** |
| `CreateGroup` | **Domains → Default → Groups → berth-trial-executor**; inspect its users |
| `CreateApiKey` | Trial user's **Tokens and keys → API keys** (older layout: **Resources → API Keys**); compare fingerprint |
| `CreatePolicy` | **Identity & Security → Identity → Policies**, root compartment → `berth-trial-objectstorage` |

4. If the outcome is still uncertain, open **☰ → Observability & Management → Logging → Audit** and
   inspect events around the journal's UTC timestamp in the home region. Use the
   root compartment for IAM operations and check the new compartment where relevant.
   Allow for propagation/late completion; one empty listing does not establish absence.
5. Stop and obtain a recovery review before another write if any intent is unresolved.
   Provide only the operation name, safe HTTP status and whether a resource is visible;
   keep credentials and identifiers private.

Fresh `apply` has no automatic resume, adoption or rollback. Only the linked
recovery command supports the specific rejected-user state. Existing output folders
are deliberately refused. Manual completion of a partial run needs a separate,
resource-specific recovery procedure; do not reconstruct credentials from source
code or guess which creation steps to repeat.

## Cleanup and operating limits

- Keep the trial compartment empty until the approved bucket/object trial.
- Administrator apply: at most eight requests, including one Object Storage namespace
  read and five IAM writes. Each request has a 15-second timeout; no retries or redirects.
- Each verifier run: two Object Storage reads and one Monitoring query; no pagination,
  retries or resource writes. Repeated runs consume additional request allowance.
- If you created a temporary administrator key in step 3, revoke **that key only**
  after setup/recovery are complete: **Profile → User settings → Tokens and keys →
  API keys**, match its fingerprint, use the row's **⋯ → Delete**, and confirm.
  Do not revoke a reused administrator key needed elsewhere or the trial key prematurely.
- Later deployment receives only trial secrets, server-side. No administrator key
  belongs in Neon runtime configuration or Angular.
- After the trial, the owner disables schedules, reconciles exact owned resources,
  revokes the trial API key, removes deployed credentials, and removes the dedicated
  policy/group/user and empty compartment. Never delete the Default domain, shared
  resources or recovery evidence while outcomes remain unresolved.

Live OCI readiness remains pending until the owner runs these checks. Automated
unit tests are not live evidence. The recorded Neon database success is independent
of OCI setup; see [account readiness](trial/account-readiness.md).
