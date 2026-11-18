# Owner-managed closeout — issue #15

Latest follow-up: the compartment returned **DELETED** on November 18 at
15:44:14 UTC. Earlier DELETING entries below are dated snapshots.

Owner administrative closeout was performed on **2026-11-18**, after the failed
November 15 trial. No new trial, deployment, schedule, bucket or object was created.
The live feasibility verdict remains **partial / no-go**, and the lifecycle remains
**failed**. PR #50 remains draft. Merged #58 fixes the metadata request but does not
change this evidence or authorize another run.

## Verified shutdown evidence

Read-only checks completed at **11:19:51 UTC / 13:19:51 Sofia** using the existing
owner credentials. Raw responses are retained privately, outside Git.

| Check | Result and scope |
| --- | --- |
| Neon branch function inventory | Empty, no continuation page; no active or obsolete trial function remains |
| Neon trigger inventory | Empty; the saved trial schedule cannot dispatch new work |
| OCI signing keys for trial user | Zero; the dedicated key revoked November 15 remains absent |
| OCI identity and resources | Administrator-authenticated GetNamespace matched the saved namespace; complete dedicated-compartment listing was empty |
| Durable SQL outcome | `failed`, feasibility `partial`, Functions allowance `unknown`, `hardSpendingCap=false` |
| Request/attempt resolution | Zero unresolved requests and zero open attempts |
| One-use exception | One retained row for the existing operation/window; never reset or deleted |
| Work after original expiry | Zero request reservations, HTTP receipts or execution deliveries timestamped after expiry |
| Post-shutdown platform logs | Query from November 15 13:51:13 UTC through closeout returned zero records, no truncation/continuation |

November 15 shutdown had already deleted the function and trigger by 13:51:12 UTC,
verified resource absence at 13:51:48 UTC and revoked the trial key at 13:52:29 UTC,
before the original 17:50 UTC administrative deadline. No shutdown mutation was
replayed on November 18 merely to produce new timestamps.

The current SQL and log checks show no recorded late execution. Log retention and
coverage are provider-controlled; an empty result cannot establish a provider-billed
zero. Residual no-op invocation **billing is unknown**, and Functions allowance is
still unknown. No paid consumption API or upgrade was used. The original deployment
expiry guard rejects late invocations before SQL/provider work; deleted hosting,
revoked credentials and removed IAM grants additionally prevent this trial from
restarting through its former schedule. No live invocation was sent to test that.

## Dedicated IAM cleanup

After authenticated resource absence and resolved SQL work were established,
owner-only cleanup used the exact identities from the original bootstrap journal.
It checked the policy name and all three compartment-scoped statements, user/group
names and exclusive group membership, and the compartment's name/root parent.
Deletion used observed revisions where returned. No automatic retries occurred.

- Dedicated Object Storage/Monitoring policy: DELETE succeeded; subsequent GET
  returned `NotAuthorizedOrNotFound`. This alone is not an absence proof; it is
  combined with the successful DELETE and preceding authorized identity read.
- Dedicated group and API-only user: DELETE succeeded; subsequent SCIM reads
  returned HTTP 404. The Default domain was preserved.
- Empty trial compartment: DELETE accepted at **11:21:30 UTC / 13:21:30 Sofia**;
  subsequent read returned **DELETING**. This is an asynchronous tombstone, not
  claimed completed removal. It contains no trial bucket/object and has no trial
  principal, signing key, policy or scheduled execution left.

Two pre-write guards stopped during verification: the policy's actual recorded name
has the `-objectstorage` suffix, and SCIM requires explicit selection of `members`.
The owner reconciled these against the setup and read the bounded membership
projection before any DELETE. No uncertain deletion was replayed.

## Retained material and boundaries

- Preserve the SQL ledger, failed outcome, consumed exception, usage history and
  private bootstrap/recovery/closeout journals. No schema, counter or evidence reset.
- The Neon Free project, branch and restricted SQL role remain for that evidence.
  They have no deployed executor or schedule. Administrative SQL reads during
  closeout may wake compute and consume Free usage; this is not a zero-cost claim.
- The administrator key is retained as an existing owner credential; its origin as
  temporary or reused is not proven. It was never deployed. Do not revoke an owner
  credential on an assumption that it is exclusive to Berth.
- Local private files remain owner-only for reconciliation, including revoked trial
  key material and obsolete configuration. Revocation prevents that key's cloud
  authentication; it does not erase local copies. Do not reuse the old configuration.
  No private file was copied into this PR or deleted to conceal history.
- The unrelated root bucket and Default identity domain were untouched. The pending
  compartment tombstone is the only asynchronous dedicated OCI removal noted here.

## Closeout decision

Operational shutdown and dedicated IAM removal are complete; compartment deletion
is accepted and remains asynchronous. There is no identified unresolved owned
bucket/object or executable trial deployment. Retain the tombstone status and
unknown residual billing as explicit limitations. They do not turn the failed
hosted lifecycle into success.

The original cleanup accounting remains nine normal ledger requests and sixteen
cleanup ledger requests, plus two separately reserved owner absence reads:
**18/40 cleanup requests**, with no reserve expansion. November 18 adds two
administrator Object Storage verification reads outside the finalized operation,
plus bounded IAM/Neon/log/SQL administrative reads and dedicated IAM deletions.
These are separate accrued account activity; they are not inserted retroactively
into the terminal ledger or represented as new trial allowance.

Future live work requires a separate explicit owner decision. Keep PR #50 draft
and the one-use exception consumed. Review this closeout independently of the
remaining upload/checksum, metric/warning, interruption and autonomous-teardown gaps.

## Repository verification and review limitations

`pnpm check` on November 18 passed 158 application tests, 28 harness tests,
lint/types, bundle and secret scanning, but **failed the dependency advisory gate**.
The unchanged lockfile now reports GHSA-fc5q-39xc-vjpf, a high-severity picomatch
ReDoS advisory (affected <=4.0.7; audit reports no patched version), via Alchemy and
its globbing dependencies. Seven moderate and one low advisories also remain.
This documentation-only closeout introduces no dependency or executable-code change.
The stopped trial exposes no deployed handler; glob-pattern reachability in build
and future runtime use requires separate triage. No waiver or suppression was added.
The follow-up issue linked in this PR owns remediation; next upstream review is due
November 20. The full canonical check must not be described as passing.

`git diff --check` and commit-time fast gates verify the final documentation.
No new behavior was implemented, so no new behavioral test or live run is needed.
Existing recovery coverage remains unchanged. Raw administrative results and journal
remain private under the owner-only closeout directory; published evidence contains
no credential values or private resource identifiers.

## Rebase follow-up — 2026-11-18 15:44 UTC

After rebasing onto merged PR #63, one administrator-authenticated, no-retry
GetCompartment read returned **DELETED** at 15:44:14 UTC / 17:44:14 Sofia. This
supersedes the earlier DELETING snapshot; no deletion request was replayed. The
read is separate administrative account activity outside the finalized ledger.
The dedicated compartment now has a confirmed deleted lifecycle state. Retained
private evidence, unknown billed residual usage and the failed/partial trial
verdict remain as recorded. No new live trial or slot reset occurred.

The earlier dependency-gate failure is historical evidence. Current main includes
the owner-approved exception from PR #63; rebased verification uses its separate
qualified path, retaining native audit failure and fixed November 25 UTC expiry.
