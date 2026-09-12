# DBOS competing submissions and client recovery

2026-09-08. Four additional actual-client/database observations, first run exit0.
This extends the five transaction observations; those earlier acceptance cases
were not repeated. Fresh DBOS schema/queue preparation is prerequisite setup.

Command: `node --import tsx research/reuse-comparisons/f1-postgres-run.mjs /private/tmp/cr-compare-f1.9x5bSO recovery`.
The existing runner permits exactly the named transaction/recovery modes. No
arbitrary fixture path, external database or service endpoint is accepted. Actual
DBOS4.27.6, PostgreSQL18.4 and unchanged CR SQL transaction adapter execute.

| Case | Actual result | What this does not prove |
| --- | --- | --- |
| Two parallel client submissions, same ID/different input | Two handles name the same workflow; one database row; this run retained `left` input | Guaranteed overlapping engine critical sections; canonical intent authorization or a valid changed-payload replay |
| Two independent IDs | Two retained workflow rows | Worker concurrency, review-wait isolation or eligible native pickup |
| Lost caller acknowledgement after successful transaction | Deliberately raised caller error; public retrieveWorkflow/getWorkflowInputs recovers original input; enqueue count stays five | Physical network loss or server crash during COMMIT; a real remote side effect |
| Destroy/recreate SDK and CR database client objects | Existing workflow/input can be read without another enqueue | Process/engine crash, daemon restart or resumption of running workflow code |

The real candidate receives a query bridge backed by the actual application
DatabaseSession. The test uses no native task registration/approval/worker. All
five enqueues are fixture operational records, not five agent runs. Original
inputs are retrieved using the actual public SDK handle, not a look-alike result.
No candidate execution worker is installed or launched.

## Interpretation

This is useful evidence for the post-commit uncertainty branch: read an existing
explicit identity before considering another submission. It does not allow the
adapter to fabricate a matching canonical receipt or authorize changed input.
Both callers obtaining a handle is intentionally recorded as behavior, not
interpreted as two separately authorized tasks or a rejection of the loser.

The remaining queue decision must still compare current canonical admission,
eligibility, scheduling and worker/recovery semantics across viable contenders.
Existing pg-boss evidence may be reused only at matching scope; Hatchet's finite
deduplication and external transaction seam remain materially different. Do not
select DBOS solely because this packet has four passing checks.

## Resources, provenance and cleanup

No new downloads or install. Existing owner-approved package links/distributions
are retained. The temporary cluster disables TCP, rejects host auth and uses an
owned private Unix socket. Runner verifies empty listen_addresses before testing.
The test subprocess has a60second deadline and bounded output; individual queries
use the configured client/server timeouts where specified. This is not a measured
RSS envelope or hostile-local-host authentication qualification.

`f1-dbos-recovery-evidence.json` retains the complete tool-returned command output,
exit0 and cleanup line without rerunning for capture. Runner stopped the cluster,
verified pid/socket absence and removed its exact child directory; root then
checked no pg-run children remain. No production configuration, user database,
provider, daemon registration or application source was changed. Independent
review of the actual fixture and receipt in f1-postgres-review.md found no material
blocker to these narrow observations. The narrative was written after that review;
root checked it against the reviewed scope. No all-F1 completion is claimed.
