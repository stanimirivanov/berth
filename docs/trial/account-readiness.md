# Trial account readiness — issues #3 and #18

Status: **incomplete**. The owner reports successful Neon apply and verify in AWS
Ohio (`aws-us-east-2`), with `databasePermissions: passed` at
**2026-11-12T17:04:05.362Z**. The supplied redacted result confirms project/region,
one branch/endpoint, scale-to-zero and database permission verification. This is
owner-reported live evidence, not an independent agent run. PR #17 is merged;
OCI recovery (#24 / merged PR #25) is complete. The owner reported two remaining
IAM writes completed and restricted verification passed at
**2026-11-13T09:17:58.368Z** after an initial HTTP 401. Propagation is a possible
explanation, not an established cause. Fingerprint and user OCID matched.

Issue #26 added [agent-operated diagnostics](../oci-doctor.md). The final authorized
live run at **2026-11-13T09:46:59.441Z** passed with one attempt: three Berth read
requests, no material clock skew (reported 0 seconds), and one OCI CLI 3.96.2
namespace comparison, which matched. Namespace and empty-compartment checks passed;
Monitoring accepted the query but returned no metrics. This is agent-run live
evidence, not just mocked acceptance. No administrator credentials or cloud writes
were used by the doctor.

During implementation, three live diagnostic runs followed relevant changes;
each made three Berth requests plus one CLI namespace request. Total: nine Object
Storage reads and three Monitoring queries, no resource mutations. Private evidence
remains outside Git. Empty metrics are inconclusive, not zero usage or billing.

Record redacted outcomes here after verification; keep IDs, connection strings,
API keys, private keys and private credential files out of Git and GitHub.

| Check | Evidence/status |
| --- | --- |
| Neon project region | Ohio; verified by owner-run script |
| Free plan, no promotional-credit dependency | Owner-attested in successful script run; independent billing verification pending |
| One branch/endpoint, scale-to-zero | Verified by owner-run script |
| Functions and scheduled-trigger availability | Pending console/deployment check |
| Restricted SQL role and owner-held schema | Applied and verified by owner-run script |
| Actual runtime login, CRUD and denied DDL/admin | Passed in owner-provided result at timestamp above |
| No alternate injected owner credentials | Pending later deployment verification |
| Schedules disabled | Pending owner check; script creates none |
| Dated database/Functions/network allowance headroom | Pending owner check |
| OCI identity, policy, home-region eligibility and aggregate headroom | Recovery and restricted read-only verification passed; effective-IAM review, eligibility and dated aggregate headroom remain pending |
| Administrative cleanup ownership | Account owner; completion pending trial |

The script's redacted result can establish database permissions only. Do not
infer complete issue acceptance from a successful command. Recheck allowance
headroom before live cloud writes. See [bootstrap guide](../neon-bootstrap.md).

Use the [OCI setup guide](../oci-bootstrap.md) for the remaining effective-IAM
review and allowance attestation. Use [doctor:oci](../oci-doctor.md) for subsequent
bounded diagnostic runs.
No bucket/object writes have been performed or claimed by this change.
