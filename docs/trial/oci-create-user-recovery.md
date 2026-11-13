# Recover `oci-bootstrap-02` after CreateUser HTTP 400

**Latest owner result (2026-11-13):** recovery preflight passed, but the recovery
CreateUser also returned HTTP 400. Its response detail was discarded by the
version run. That directory now has a recovery-start entry and must not be replayed
or edited back to four entries. The creation failure is unresolved; the commands
below describe the originally supported prefix, not permission to repeat this run.

## Diagnosing the second rejection

- Do not rerun apply/recover, change the resource name, or remove recovery entries.
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


Use this procedure for the owner-reported run on 2026-11-12:

- `CreateCompartment` succeeded and its OCID was recorded.
- `CreateUser` returned HTTP 400. The owner subsequently found no matching user.
- No group, key registration or policy was attempted in that run.
- The original four-entry journal and generated keys are still in `oci-bootstrap-02`.

Issue #22 added Oracle's required `name.familyName` to the service-user request.
Issue #24 adds the narrow recovery below. This is not a general resume mechanism.
No live recovery has been performed by the agent.

## 1. Keep the existing files and confirm the failure

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

The old journal did not record the HTTP status. The execution flag in step 3 is
an explicit owner attestation of the rejection and exclusive operation, not an
API-derived fact or permission to bypass a conflicting resource.

## 2. Run the read-only cloud preflight

Run from the `berth` checkout in a local Bash terminal:

```bash
cd "$HOME/sources/infra-as-code/berth"
BERTH_PRIVATE_DIR="$HOME/.config/berth-trial"
BERTH_OCI_RUN="$BERTH_PRIVATE_DIR/oci-bootstrap-02"

pnpm run setup:oci-admin \
  --config "$BERTH_PRIVATE_DIR/oci-admin.json" \
  --output-dir "$BERTH_OCI_RUN" \
  --mode recover-plan
```

Use the **existing** directory. Do not create `oci-bootstrap-03` or run `apply`.

Unlike the ordinary offline `plan`, `recover-plan` reads your keys and makes up to
**eight signed GET requests**. It checks:

1. Local directory/file ownership, permissions, symlinks, exact supported journal
   sequence, target consistency and the original trial key pair/fingerprint.
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
  --confirm-user-create-rejected
```

The command repeats all live checks, then appends and syncs a `recovery-start`
record before any new mutation. It performs only these four writes:

- Create the API-only service user with the corrected SCIM name.
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
| Local validation or preflight fails, with the original four-entry journal unchanged | Correct the reported condition or obtain a review. A read-only `recover-plan` can be repeated after the condition is resolved. Never bypass a mismatch by editing the journal. |
| A `recovery-start` entry exists, even if no later confirmation exists | Stop. This version deliberately refuses any further recovery from that journal. Preserve all files and reconcile the new intents/results before further writes. |
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
[exact policy-name filtering](https://docs.oracle.com/en-us/iaas/tools/oci-cli/latest/oci_cli_docs/cmdref/iam/policy/list.html).
