# Trial account readiness — issues #3 and #18

Status: **incomplete**. The owner reports successful Neon apply and verify in AWS
Ohio (`aws-us-east-2`), with `databasePermissions: passed` at
**2026-11-12T17:04:05.362Z**. The supplied redacted result confirms project/region,
one branch/endpoint, scale-to-zero and database permission verification. This is
owner-reported live evidence, not an independent agent run. PR #17 is merged;
The owner subsequently reported a confirmed OCI compartment creation followed by
CreateUser HTTP 400 on 2026-11-12, and no matching user in the Console. Recovery
is tracked in #24; this is still owner-reported evidence, not an agent-run check.

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
| OCI identity, policy, home-region eligibility and aggregate headroom | Partial: compartment created, user rejected; #24 recovery, effective-IAM review and restricted verification pending |
| Administrative cleanup ownership | Account owner; completion pending trial |

The script's redacted result can establish database permissions only. Do not
infer complete issue acceptance from a successful command. Recheck allowance
headroom before live cloud writes. See [bootstrap guide](../neon-bootstrap.md).

Use the [OCI setup guide](../oci-bootstrap.md) next. OCI verification time,
read-only result, effective-IAM review and allowance attestation remain pending.
No bucket/object writes have been performed or claimed by this change.
