# Trial account readiness — issue #3

Status: **incomplete**. The owner reports a Neon project created in AWS Ohio
(`aws-us-east-2`). No live setup script or permission checks have been run by the
agent. The owner chose to run the Neon-only script locally.

Record redacted outcomes here after verification; keep IDs, connection strings,
API keys, private keys and private credential files out of Git and GitHub.

| Check | Evidence/status |
| --- | --- |
| Neon project region | Ohio, owner-reported; API verification pending |
| Free plan, no promotional-credit dependency | Pending owner console check |
| One branch/endpoint, scale-to-zero | Pending script run |
| Functions and scheduled-trigger availability | Pending console/deployment check |
| Restricted SQL role and owner-held schema | Pending script apply |
| Actual runtime login, CRUD and denied DDL/admin | Pending script verification |
| No alternate injected owner credentials | Pending later deployment verification |
| Schedules disabled | Pending owner check; script creates none |
| Dated database/Functions/network allowance headroom | Pending owner check |
| OCI identity, policy, home-region eligibility and aggregate headroom | Pending separate OCI setup |
| Administrative cleanup ownership | Account owner; completion pending trial |

The script's redacted result can establish database permissions only. Do not
infer complete issue acceptance from a successful command. Recheck allowance
headroom before live cloud writes. See [bootstrap guide](../neon-bootstrap.md).
