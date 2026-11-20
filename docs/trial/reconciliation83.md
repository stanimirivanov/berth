# Read-only reconciliation — issue #83, November 20, 2026

**The saved bucket is present and currently empty, with matching ownership and
revision.** Hosting remains absent. The original PUT is still unresolved; nothing
was deleted, revoked, settled or restarted by this assessment. A separate owner
decision is required for the proposed after-expiry cleanup below.

## Authenticated observations

Owner reads ran at approximately **13:32–13:35 UTC / 15:32–15:35 Sofia**, after
issue #76's original **10:50 UTC / 12:50 Sofia** cloud-work expiry. Raw evidence
is retained owner-only in `~/.config/berth-trial/reconciliation83-01/`.
Identifiers, object contents and credentials are omitted here.

| Check | Observation |
| --- | --- |
| SQL transaction | Owner login, explicit read-only transaction |
| Operation | `needs-reconciliation`, pending upload true, no checksum receipt, retained Alchemy state |
| Outstanding work | One unresolved mutating PUT; four open attempts |
| Accounting | Normal 15/160; cleanup 14/40, **26 remaining**; no reserve/counter/expiry changes |
| Authorizations | One retained historical exception, one new Functions policy, one new allowance singleton |
| Historical trial | Failed, normal 9 and SQL cleanup 16; unchanged |
| Bucket identity | Provider ID, compartment, namespace, name, operation tag and random marker all match persisted intent |
| Bucket revision | Current provider ETag matches the saved creation revision |
| Bucket settings | Private, Standard, versioning Disabled, auto-tiering Disabled, events false, Oracle-managed encryption, not read-only, replication disabled; no lifecycle-policy ETag |
| Objects and versions | Zero objects and zero versions, complete single pages |
| Multipart work | Zero uploads, no continuation |
| Retention and grants | Zero retention rules and zero pre-authenticated requests, no continuation |
| Trial key | Exactly one registered key; fingerprint matches the dedicated trial configuration |
| Hosting | Zero Functions and zero triggers; inventories have no continuation |

The provider's approximate size/count fields are null and were not interpreted as
zero. Actual complete inventories establish the dated empty-bucket observation.
No HEAD or object-content GET was needed. Empty inventory does **not** prove that
PUT was never dispatched, provide a checksum receipt, or clear an uncertain write.
Neither missing Audit nor elapsed time substitutes for that evidence.

A second read-only SQL snapshot compared report, requests, attempts, engine state,
authorization counts and both trials with the first. All captured fields matched;
request/attempt arrays were compared without depending on row order. The historical
partial/no-go and the current unresolved/partial outcome remain unchanged.

## Request accounting and limits

This separately authorized owner investigation made **six successful Object Storage
GET/list requests**, one IAM key-list read and two Neon inventory GETs, plus two
read-only SQL sessions. It did not reserve requests in the expired operation or
claim its remaining 26 requests as a new administrative budget. These reads can
consume provider usage/wake SQL; they are not claimed free of all metering.

One unsupported Python SDK `limit` argument on retention listing was rejected
locally before an HTTP request. The corrected call omitted that unsupported
argument, returned an empty page and did not repeat an executed provider request.
Other successful reads were not repeated; no automatic retries or pagination loops
were used. The original stopped partial inspection and corrected response are
both retained privately.

## Concrete cleanup proposal — not authorized or executed

The normal executor cannot be resumed after expiry. Current facts support proposing
an **exceptional, separately authorized owner closeout**, not changing its guards
or declaring the software lifecycle successful. The unresolved historical PUT and
possible late-completion uncertainty must remain explicit in that owner decision.

Proposed scope is only the existing `berth-validation76` bucket/identity recorded in
`live76-01` and `oci-bootstrap76-01`. Do not adopt another name or create anything.

1. Recheck the saved bucket ID, both ownership tags, saved ETag and approved settings.
   Require complete empty object/version/multipart/grant inventories and no retention
   or replication. A revision/configuration change, unexpected content, denied read
   or continuation stops the action for review; never silently refresh the target.
2. Send **one API `DeleteBucket` with `If-Match` bound to that observed revision**.
   No object deletion, bulk cleanup, multipart abort, Console cascade, unconditional
   fallback or automatic retry. If the request fails/times out, retain its intent
   and reconcile its outcome before another mutation.
3. Verify the successful deletion with the authenticated owner: the known DELETE
   response, a bucket GET absence response, and a complete empty compartment listing
   must agree. A standalone 404 `NotAuthorizedOrNotFound` is insufficient. A late
   object/nonempty-bucket rejection stops cleanup; no objects are removed to force it.
4. Only under the same explicit owner decision, after verified bucket absence,
   revoke the exact trial key; revalidate and remove the dedicated policy, exclusive
   group/service user and empty compartment. Match identifiers to the new bootstrap
   journal, compare the exact policy statements and use observed revisions where
   supported. Preserve the Default domain, unrelated root bucket and administrator
   key. Any ambiguity or nonempty compartment stops; do not purge unrelated resources.
   Treat compartment DELETING as asynchronous, not completed deletion.
5. Retain separate owner closeout receipts. **Do not alter the unresolved PUT,
   ledger outcome, immutable policy, counters or original timestamps** to make the
   application report appear successful. Manual resource removal would not pass the
   autonomous teardown criterion. Issue #76 remains partial/no-go and its software
   reconciliation gap remains tracked by #81.

Proposed new administrative bounds: at most **nine Object Storage requests**
(six fresh guard reads, one conditional DELETE, one absence GET and one complete
compartment listing); at most **20 IAM/domain requests**, including at most five
mutations for key, policy, group, user and compartment. No retries or page traversal;
if that scope cannot complete, stop and report what remains. This is a new,
separately approved owner scope, **not an extension/refund of the expired 26-request
reserve**. No additional live validation, deployment, paid plan or operation UUID
is included. No cleanup script or mutation was executed by this PR.

Oracle documents that API bucket deletion requires an empty bucket and that
objects/versions, pre-authenticated grants, replication and multipart work can
prevent deletion. Its Console can remove contents as part of deletion; that is why
the proposal uses only the conditional API, with no content-removal fallback.
[Bucket deletion](https://docs.oracle.com/en-us/iaas/Content/Object/Tasks/managingbuckets_topic-To_delete_a_bucket.htm),
[SDK `DeleteBucket` / `if_match`](https://docs.oracle.com/en-us/iaas/tools/python/latest/api/object_storage/client/oci.object_storage.ObjectStorageClient.html#oci.object_storage.ObjectStorageClient.delete_bucket).
Those contracts do not prove the earlier PUT's dispatch or completion. The
installed owner SDK also documents the conditional parameter; it was inspected,
not invoked. The unresolved-write stop in the original executor is preserved.

## Scope of implementation and verification

This task changes evidence documentation and the ordered index only. No production
behavior, tests, harness gates or recovery coverage changed. The requested TDD
skill excludes documentation-only changes; no artificial red/green test or live
mutation was invented to satisfy a test label. #81 remains the separate TDD task
for the actual PUT defect; #80 owns empty-body hosted controls.

Repository verification uses `pnpm check:fast`, canonical `pnpm check`, secret scan
and final diff review. Real read-only observations above are not substituted for
upload/checksum, warnings, missed-delivery recovery or autonomous teardown proof.
