# Recover `oci-bootstrap-02` after CreateUser HTTP 400

**Confirmed cause (owner Audit evidence, 2026-11-13):** “The primary email must be
specified.” The corrected request now supplies an explicit `trialEmail` and requests
suppression of the creation notification. Your six-entry journal from the second
rejection is supported after validation and explicit confirmation of this Audit
message. Keep every journal entry and both keys unchanged. Live success remains
unverified until you run the revised command.

## Evidence and diagnostics

- Do not repeat older apply/recover commands, change the resource name, or remove
  recovery entries. Use only the revised, attested recovery procedure below.
- Open **Observability & Management → Logging → Audit**, select the tenancy root and the home region,
  then choose **Edit → Custom**, enter a time range covering the failed recovery,
  and select **Update**. Leave User/Resource/Type filters unset initially. In
  **Explore events**, expand the relevant POST event with status 400, if present,
  and inspect its validation message. Absence of an event is inconclusive.
  Navigation source: [Oracle Audit Logs](https://docs.oracle.com/en-us/iaas/Content/Logging/Concepts/audit_logs.htm).
- Share only the relevant error/validation text after redacting account identifiers,
  email addresses and other private data. Do not share a complete event or journal.
- Oracle directs modern identity-domain audit queries to OCI Audit; legacy identity
  domain AuditEvents/report APIs no longer receive new events. See
  [Oracle's audit migration notice](https://docs.oracle.com/en-us/iaas/Content/Identity/api-getstarted/usingauditeventapis.htm).
- The revised command captures **future** CreateUser HTTP 400 bodies in
  `create-user-error.json` inside the existing private run directory. It reads at
  most 16 KiB, records whether the body was truncated/unavailable, writes mode 600,
  and refuses to overwrite an existing diagnostic. No headers or credentials are
  deliberately collected; provider text can nevertheless contain private account
  data, so treat the whole file as sensitive, untrusted diagnostic data.
- Provider detail is never printed or appended to the journal. Open a diagnostic
  privately in an editor and share only a redacted validation message. This cannot
  recreate already discarded responses and is not a reason to repeat a mutation.


Use this procedure for the owner-reported run and its rejected recovery:

- `CreateCompartment` succeeded and its OCID was recorded.
- `CreateUser` returned HTTP 400. The owner subsequently found no matching user.
- No group, key registration or policy was attempted in that run.
- The original journal and generated keys remain in `oci-bootstrap-02`; the failed
  recovery appended one recovery-start record and one corrected CreateUser intent.

Issue #22 added Oracle's required `name.familyName` to the service-user request.
Issue #24 adds the narrow recovery below, including the confirmed missing-email rejection. This is not a general resume mechanism.
No live recovery has been performed by the agent.

## 1. Add the required email, preserving recovery evidence

Open the private administrator configuration:

```bash
BERTH_PRIVATE_DIR="$HOME/.config/berth-trial"
nano "$BERTH_PRIVATE_DIR/oci-admin.json"
```

- Add a comma after `"name": "berth-trial"` and add
  `"trialEmail": "YOUR_REAL_EMAIL_ADDRESS"` before the closing brace.
- Replace the placeholder with an address you control. Do not include a display
  name, surrounding whitespace or a fake/example address. Do not send the address
  to chat or GitHub.
- Leave the tenancy/user/domain OCIDs, region, administrator fingerprint and key
  path unchanged. The email is not an administrator credential.
- Save with Ctrl+O, Enter; exit with Ctrl+X. Keep the file mode 600.
- The email is sent to OCI in the user request and recorded in the protected
  journal. It is not printed in plan/success output or copied to runtime config.
  User-creation notification is suppressed through Oracle's `bypassNotification`
  flag; no email-send API is called.

Then confirm the failure state:

- Use the merged recovery code and the pinned Node/pnpm versions in the checkout.
- Keep `journal.jsonl`, `trial.pem` and `trial-public.pem` unchanged. Do not copy a
  journal from another run, remove entries, replace keys or rename the compartment.
- Use the corrected administrator configuration: `privateKeyFile` references
  `oci-admin.pem`, never its public key. Paths in JSON must be absolute.
- Confirm the original response was **CreateUser HTTP 400**, not a timeout,
  lost response, process interruption or a 5xx response. An empty user listing
  alone cannot settle an uncertain request. Other failure types require review.
- Ensure nobody else is running bootstrap/recovery or changing these resources.
- In **Identity & Security → Domains → Default → User management → Users**
  (older layout: **Users** sidebar), confirm `berth-trial-executor` is absent.
  If present, stop; recovery does not adopt users, groups or policies.

The old journal did not record the HTTP status. `--confirm-user-create-rejected`
attests rejection and exclusive operation. For your six-entry journal,
`--confirm-primary-email-rejection` additionally attests that the latest attempt
was rejected with the Audit message above. Neither flag bypasses live conflict
checks. Do not supply the second flag for a timeout, unknown outcome or different
validation error. Four-entry journals from the first rejection do not need it.

## 2. Run the read-only cloud preflight

Run from the `berth` checkout in a local Bash terminal:

```bash
cd "$HOME/sources/infra-as-code/berth"
BERTH_PRIVATE_DIR="$HOME/.config/berth-trial"
BERTH_OCI_RUN="$BERTH_PRIVATE_DIR/oci-bootstrap-02"

pnpm run setup:oci-admin \
  --config "$BERTH_PRIVATE_DIR/oci-admin.json" \
  --output-dir "$BERTH_OCI_RUN" \
  --mode recover-plan \
  --confirm-primary-email-rejection
```

Use the **existing** directory. Do not create `oci-bootstrap-03` or run `apply`.

Unlike the ordinary offline `plan`, `recover-plan` reads your keys and makes up to
**eight signed GET requests**. It checks:

1. Local directory/file ownership, permissions, symlinks, exact supported four- or
   six-entry legacy journal, target consistency and the original trial key pair.
   For six entries, the existing recovery marker's hash must match the untouched
   first four entries, and the last request must be the old name-only user payload.
2. The administrator key, actual tenancy home region and authenticated domain URL.
3. The recorded compartment's OCID, parent tenancy, name, description and ACTIVE state.
4. No buckets in that compartment; no pagination marker.
5. No exact matching user or group in the selected domain, and no matching root policy.
   Incomplete, conflicting or ambiguous responses stop recovery.

Expected output:

```json
{
  "recovery": "ready",
  "requestsDispatched": 8,
  "remainingWrites": 4
}
```

This leaves the journal and keys unchanged and makes no cloud writes. It creates
and removes a local `recovery.lock` to exclude another invocation in the same
directory. It does not reserve cloud names or prove that an old uncertain request
cannot finish later; step 1's rejection confirmation remains necessary.

## 3. Recover once, reusing the compartment and trial key

After successful preflight, run:

```bash
pnpm run setup:oci-admin \
  --config "$BERTH_PRIVATE_DIR/oci-admin.json" \
  --output-dir "$BERTH_OCI_RUN" \
  --mode recover \
  --confirm-user-create-rejected \
  --confirm-primary-email-rejection
```

The command repeats all live checks, then appends and syncs a `recovery-start`
record before any new mutation. It performs only these four writes:

- Create the API-only service user with the corrected SCIM name, primary email
  and creation-notification suppression.
- Create the dedicated group with that user as its member.
- Register the **existing** `trial-public.pem` with the new user.
- Create the three scoped policy statements using the **existing** compartment OCID.

Expected output includes:

```json
{
  "administratorSetup": "recovered",
  "compartment": "reused",
  "trialKey": "reused",
  "iamWrites": 4,
  "requestsDispatched": 12
}
```

`oci-trial.json` is created in `oci-bootstrap-02`, mode 600, referencing the same
`trial.pem`. The original journal entries remain; recovery entries and a final
`complete` record are appended. No administrator credential is copied into the
runtime configuration. Existing runtime output is never overwritten.

## 4. Review permissions, then verify as the trial identity

Follow [the guide's effective-IAM review](../oci-bootstrap.md#6-review-the-created-permissions-in-the-console).
Keep the compartment reserved and empty. Then run:

```bash
pnpm run setup:oci --config "$BERTH_OCI_RUN/oci-trial.json" --mode verify
```

Expected: `readOnlyAccess: passed`. An empty metric response remains inconclusive,
not evidence of zero usage. Record redacted results in
[account readiness](account-readiness.md). Account eligibility, aggregate allowance
headroom and later live bucket/object creation/teardown checks remain required.

## If recovery fails

| Result | Action |
| --- | --- |
| Local validation or preflight fails, with the supported four- or six-entry journal unchanged | Correct the reported condition or obtain a review. A read-only `recover-plan` can be repeated after the condition is resolved. Never bypass a mismatch by editing the journal. |
| Recovery fails after a new `recovery-start` from this revised command | Stop. No further replay is supported. Preserve the diagnostic, journal and keys. Only the exact older six-entry missing-email rejection is an exception, with the additional attestation above. |
| Existing user/group/policy, wrong compartment details or nonempty bucket list | Stop; inspect the exact resource. No automatic adoption, deletion or permission broadening is performed. |
| `recovery.lock` remains after a crash | Do not remove it based on age alone. Confirm no process is using the run and inspect the journal first. Removing a stale lock does not make a later-stage journal eligible for replay. |
| `oci-trial.json` already exists | Do not overwrite it or rerun recovery. Inspect completion state; use the restricted verifier after successful completion. |

All calls reject redirects and have a 15-second timeout; no automatic retries or
pagination occur. Each complete preflight consumes two Object Storage reads and
six IAM/identity-domain reads. Execution repeats those reads and adds four IAM
writes. Include repeated checks in allowance headroom. The bucket check does not
enumerate other resource types or prove absence of broader inherited permissions.
These checks do not implement a hard spending cap or enable schedules.

Sources: Oracle [Create a User schema](https://docs.oracle.com/en/cloud/paas/iam-domains-rest-api/op-admin-v1-users-post.html),
[domain query filters](https://docs.oracle.com/en-us/iaas/Content/Identity/api-getstarted/OCISQueryParameters.htm),
[exact policy-name filtering](https://docs.oracle.com/en-us/iaas/tools/oci-cli/latest/oci_cli_docs/cmdref/iam/policy/list.html),
[primary email example](https://docs.oracle.com/en-us/iaas/tools/terraform-provider-oci/latest/docs/r/identity_domains_user.html),
[notification suppression](https://docs.oracle.com/en-us/iaas/Content/Identity/tutorials/okta/lifecycle_okta/okta-lifecycle.htm).
