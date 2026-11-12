# OCI and Neon trial setup

Status: Neon project created in Ohio (owner-reported); remaining setup and live verification pending. Sources checked 2026-11-12.

## Account owner actions

### Neon

For the existing Ohio project, use the parameterized [Neon bootstrap script](neon-bootstrap.md)
to prepare and verify database permissions. Ohio is also a supported Functions
region; recreating the project in Frankfurt is unnecessary. The script leaves
deployment checks and OCI setup pending; track results in
[account readiness](trial/account-readiness.md).

1. Use the existing Neon project on the **Free** plan in AWS Ohio (`aws-us-east-2`), a Functions-supported region. AWS Frankfurt (`aws-eu-central-1`) is also supported for new projects. Confirm Functions and scheduled Function Triggers are available in the actual project before continuing. Do not upgrade if unavailable.
2. Enable Postgres on one trial branch. Keep scale-to-zero enabled. Do not enable AI Gateway, paid services, or production branch copies for this trial.
3. Use the owner's Neon login for initial deployment. If automation requires an API key, use the narrowest project scope offered; keep it in deployment tooling, never in the function runtime or Angular bundle.
4. Create a dedicated runtime database role with CONNECT, schema USAGE and only the table/sequence or narrowly scoped function permissions needed for trial operations/state. It must not own schemas/tables, create or alter schema, create roles, bypass access controls, or access unrelated application data. Keep migrations under a separate owner credential. Replace the injected connection string if it grants broader rights, and ensure the execution deployment cannot access an injected owner connection through another variable. Verify positive CRUD/transaction behavior and negative DDL/admin tests before OCI writes. If the chosen Alchemy state backend requires runtime migrations or broader privileges, that is an unresolved compatibility issue, not permission to retain admin credentials.
5. Supply OCI credentials as server-side function environment variables, resolved from a private environment at deployment. Do not put secret values in `neon.ts`, shell command arguments, Git, HTTP responses, or logs. Neon documents config values resolved from `process.env`; variables are deployment snapshots and rotation requires redeployment. Remove obsolete credentials from old deployments and revoke the old OCI key.
6. Authenticate every manual endpoint. For the feasibility trial use a server-side trial bearer secret, supplied through a private API client; do not embed it in a public frontend. Verify scheduled invocations using Neon's documented trigger authentication. Public unauthenticated triggers must not start cloud writes.
7. Before execution record current project usage and confirm headroom. Free quotas currently include 100 database CU-hours, 1 GB database storage, 10 active and 400 waiting function capacity-hours, 1 million function invocations, and 5 GB shared network transfer per project/month. Recheck the console at setup. Capacity-hours are not equivalent to elapsed job hours.

Configure a 15-minute trial trigger and a deployment-level four-hour expiry. Keep it disabled until authentication, state persistence and budgets are verified. Owner credentials administer the trigger; executor credentials do not. Set an owner follow-up to disable/delete the trigger and revoke trial credentials after execution. No-op invocations after expiry still use function allowance; include that residual cost in preflight.

Neon does not supply a durable job queue through Functions. A successful request is insufficient: the trial must persist work and recover through a scheduled hosted invocation after the caller disconnects. Check trigger delivery, timeout and retry semantics before implementation.

### OCI

1. Record whether the tenancy is Always Free-only, trial, or paid, its **home region**, and current Object Storage usage across the tenancy. Verify remaining storage and monthly request allowance. Account status changes allowance interpretation; do not infer it from a single bucket.
2. Create an empty dedicated compartment `berth-trial`. Use it only for this disposable trial. The runtime does not need permission to create compartments, users, groups, or policies.
3. Create a dedicated API user and group `berth-trial-executor` in the intended identity domain. Ensure this user has no other group memberships or inherited grants giving broader access. OCI policies are additive.
4. Generate an RSA API signing key (PEM, at least 2048 bits) and upload only the public key to the dedicated user. Keep the private key outside the repository. Record user OCID, tenancy OCID, fingerprint, compartment OCID, namespace, and home region. Use the official OCI SDK signing support, not handwritten request signing.
5. An administrator installs the policy template below, replacing the group and compartment OCIDs. These are proposed permissions pending live validation; no policy has been applied.

```text
Allow group id <group_ocid> to manage buckets in compartment id <compartment_ocid> where any {request.permission='BUCKET_INSPECT', request.permission='BUCKET_READ', request.permission='BUCKET_CREATE', request.permission='BUCKET_DELETE'}
Allow group id <group_ocid> to manage objects in compartment id <compartment_ocid> where any {request.permission='OBJECT_INSPECT', request.permission='OBJECT_READ', request.permission='OBJECT_CREATE', request.permission='OBJECT_DELETE'}
Allow group id <group_ocid> to read metrics in compartment id <compartment_ocid> where target.metrics.namespace='oci_objectstorage'
```

The bucket permission filter deliberately omits update, retention-rule management/locking, replication and preauthenticated-link management. The object filter omits overwrite, version deletion and tier changes. A retry must inspect an existing object and verify its expected identity/content; it must not overwrite it. Use a unique run-specific bucket and object name. Persist intent and a random run marker before creation; attach that marker to bucket free-form tags and object metadata. Record bucket identity, object digest and observed ETags. Require create-only object upload and revision-bound deletion; a conflicting marker, identity or revision requires reconciliation. Use Oracle-managed encryption, no customer-managed KMS key, no retention, no versioning, no public access, no multipart upload.

`GetNamespace` without a compartment parameter can validate the caller's namespace without additional policy. Explicit region and compartment configuration avoids granting identity enumeration. Bucket creation must explicitly set private access: the create permission itself is not a guarantee of private configuration.

The IAM policy limits scope and API permissions, but it does not enforce one bucket, one object, or private-only creation. Those are application validation and post-create verification requirements. The dedicated compartment is reserved against concurrent owner writes during the trial. A compromised executor with BUCKET_CREATE remains able to choose other creation settings within that compartment; this trial does not claim IAM protection against that threat. If private-only creation must be IAM-enforced, resolve that feasibility question before enabling execution.

Permission verification distinguishes actual IAM denials (outside scope, retention APIs, overwrites) from application rejection (public settings, excess resources). Never test an irreversible retention lock by sending a live lock request merely expecting rejection. Use policy inspection plus non-destructive checks; permission tests must not mutate unrelated resources. Reserve their requests within the same trial budget. Anonymous/forged endpoint invocations must cause no writes. Do not blindly broaden permissions to fix a failed call.

Compartment-only metrics cannot prove tenancy-wide free allowance headroom. For this trial the owner provides a dated aggregate usage check; display that limitation. Automated tenancy-wide inventory/billing access is a separate future read-only scope. Unknown or stale eligibility blocks a new trial, while cleanup of owned resources remains available.

## Configuration inventory

| Setting | Purpose | Secret |
|---|---|---|
| `OCI_TENANCY_OCID`, `OCI_USER_OCID`, `OCI_FINGERPRINT` | Signing identity | Account metadata; keep private |
| `OCI_PRIVATE_KEY_PEM` | Dedicated API signing key | Yes |
| `OCI_PRIVATE_KEY_PASSPHRASE` | If key is encrypted | Yes |
| `OCI_REGION`, `OCI_COMPARTMENT_OCID`, `OCI_NAMESPACE` | Explicit target | Account metadata |
| `BERTH_TRIAL_TOKEN` | Authenticated manual trial requests | Yes |
| `DATABASE_URL` | Restricted runtime database connection | Yes; admin connections rejected |
| `BERTH_TRIAL_EXPIRES_AT` | Deployment-level UTC deadline checked before DB access | No |

Do not paste any of these values into chat. Setup status, account type and region are sufficient for planning.

## Cleanup and failure handling

The executor begins cleanup by hour three, after ceasing new create/upload calls at minute 30. Persist every dispatch before sending it, atomically reserve attempts/requests, and count unknown dispatch results as spent. SDK retries must be disabled or explicitly included. A lease timeout cannot prove an OCI request stopped; unresolved creates prevent a successful teardown verdict and require hosted reconciliation for late completion.

Delete only the object with matching precommitted marker, content and inspected revision, using If-Match; then delete the empty owned bucket with the supported revision condition. If the revision changes, stop rather than delete a replacement. Unexpected objects, versions, retention or namespace mismatch stop automatic deletion and produce an actionable report. Before the four-hour deadline, persist the outcome if possible. At expiry, refuse further cloud work and do not open a new DB connection merely to finalize the record; an unfinished record remains unresolved for owner inspection. Preserve unresolved records and a redacted cleanup report; lack of evidence is never success.

The account owner, not the restricted executor, disables/deletes scheduled triggers, revokes the dedicated API key and removes deployment secrets afterward. Hosted teardown and terminal/expiry checks operate without that owner action. A trigger already queued may still arrive after disabling; it must not restart a completed/expired trial. An expired handler returns before DB access, but still consumes some Neon function allowance. The owner must complete administrative cleanup to stop that residual use.

A failed trial still requires cleanup; creation preflight must not block teardown, but cleanup retains its own request allocation. If the reserved budget, hosting availability or deadline prevents safe cleanup, use the OCI Console as account owner: locate the exact recorded compartment/bucket, verify marker and identity, resolve uncertain writes, inspect all contents and remove only confirmed trial resources. Do not broadly empty the compartment. Record manual recovery separately from hosted acceptance.

## Sources

- [OCI Always Free resources](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm)
- [OCI Object Storage permissions](https://docs.oracle.com/en-us/iaas/Content/Identity/Reference/objectstoragepolicyreference.htm)
- [OCI Monitoring permissions](https://docs.oracle.com/en-us/iaas/Content/Identity/Reference/monitoringpolicyreference.htm)
- [OCI API signing keys](https://docs.oracle.com/en-us/iaas/Content/API/Concepts/apisigningkey.htm)
- [Neon Functions overview and regions](https://neon.com/docs/compute/functions/overview)
- [Neon Functions setup](https://neon.com/docs/compute/functions/get-started)
- [Neon environment variables](https://neon.com/docs/compute/functions/environment-variables)
- [Neon scheduled functions](https://neon.com/docs/compute/functions/triggers/schedule)
- [Neon pricing](https://neon.com/pricing)
- [OCI conditional object and bucket operations](https://docs.oracle.com/en-us/iaas/tools/python/latest/api/object_storage/client/oci.object_storage.ObjectStorageClient.html)
- [Creating a bucket with free-form tags](https://docs.oracle.com/en-us/iaas/Content/Object/Tasks/managingbuckets_topic-To_create_a_bucket.htm)
