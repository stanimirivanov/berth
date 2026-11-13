# CreateUser HTTP 400: partial bootstrap

Owner-reported run on 2026-11-12: `CreateCompartment` returned an OCID;
`CreateUser` returned HTTP 400. No later operations were dispatched by this run.
The private journal and generated key remain in `oci-bootstrap-02`.

Issue #22 corrects a request-schema defect: Oracle requires `name.familyName`;
`displayName` does not replace it. The script now uses the executor's service
label for that field. No person's name, email or new permission is needed.
The response body was discarded, so this defect is a likely cause of the live
400, not proof that no other tenant-specific validation will fail.

## Before any further write

- Do not rerun apply, rename the resource prefix, delete the compartment, or
  edit/remove the journal to bypass the existing-output guard.
- In **Identity & Security → Domains → Default**, open **User management → Users**
  (older layout: **Users** sidebar link). Search for `berth-trial-executor`.
- In **Identity & Security → Compartments**, find `berth-trial` under root and
  compare its OCID with the confirmed journal entry privately.
- Preserve the generated private key and all journal records. Share only whether
  the user and compartment exist, not their identifiers or credentials.
- If a user is present or its absence is uncertain, reconcile its identity and
  the creation event before attempting another user creation. A single immediate
  empty listing is not conclusive; check Audit and propagation when necessary.

The current command cannot resume or adopt this compartment. The fix prevents
this schema defect in subsequent creation requests; it does not repair the
partial cloud state. Owner reconciliation and a resource-specific recovery step
are still required before continuing. No cloud cleanup or retries were performed
by the code fix.

Source: Oracle's [Create a User request schema](https://docs.oracle.com/en/cloud/paas/iam-domains-rest-api/op-admin-v1-users-post.html),
which marks `name` and its `familyName` member as required.
