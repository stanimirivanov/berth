# Project current operation history and preserve dated evidence

Operation history serves the latest recorded state from a restricted PostgreSQL
projection. The Neon history service reads that projection, Cloudflare authenticates
and forwards requests, and Angular presents the results. Retained expired and
terminal operations remain readable. Pages can reflect subsequent reconciliation
and need not represent a single point in time across requests. Dated reports
preserve the evidence and conclusions available at their original cutoff.

Operation outcome belongs to one lifecycle. Feasibility verdict evaluates the
trial's capabilities and allowance evidence separately. An operation can succeed
while unproven metrics or recovery keep the verdict partial. The current API
projects a fixed partial qualifier and the UI displays the existing partial/no-go
verdict. Neither display surface owns the assessment. Application counters in
history describe recorded spend against operation limits. Provider usage and
remaining allowances require separate evidence.

See the [operation history contract](../trial/operation-history.md),
[history release guide](../../ui/cloudflare-history.md) and
[trial outcome criteria](../../SPEC.md#authorization-cleanup-and-outcome). The
[November 20 trial report](../trial/live76-results.md) and its
[later read-only reconciliation](../trial/reconciliation83.md) illustrate why
both dated records matter.
