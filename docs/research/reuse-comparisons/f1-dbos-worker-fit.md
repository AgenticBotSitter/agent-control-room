# DBOS actual worker and review-wait comparison

2026-09-08. Actual installed DBOS4.27.6 at the existing F1 package pin,
disposable PostgreSQL18.4, public registration/start/event/receive/send/result APIs.
First worker attempt exited0; no fixture repair or repeated attempt. This extends
the earlier transaction/client evidence; it does not turn it into canonical task
admission evidence. Receipt: `f1-dbos-worker-evidence.json`.

## Observed result

| Same-queue limits | Independent B while A waits for review | After releasing A |
| --- | --- | --- |
| Global/worker concurrency1 | No start event during one-second bounded observation; actual status ENQUEUED | Both actual results retrieved |
| Global/worker concurrency2 | Positive start event and actual SUCCESS status before A release | Both actual results retrieved |

Actual workflow bodies executed once each in this run: wait1, independent1, wait2,
independent2. A published a durable start event and waited using actual DBOS.recv;
the fixture released it using DBOS.send. This was not an in-memory pretend worker.
The one-second observation is finite evidence, not a universal timing guarantee.
It agrees with the inspected dispatcher counting PENDING work toward concurrency.

## Integration consequence

Do not model every pending owner review as a indefinitely running workflow and
promise that worker capacity is automatically freed. Options are a separate review
phase using Control Room's existing canonical state, or explicitly budgeting the
additional waiting workflow capacity. The latter must not be confused with an
available native agent slot. No new production scheduler is justified by this test.

DBOS remains a contender, not the final queue winner. Compare the same phase boundary
with pg-boss and the real existing Control Room lifecycle. Existing caller-transaction
proof and this public-start worker test are separate seams; a combined canonical
admission-to-pickup test is still missing. Hatchet's post-commit interface remains
an alternative whose cost must include uncertain submission/reconciliation.

## Isolation and cleanup

The root inspected launch/configuration and public types before the run. The child
started in an owned empty directory because launch reads configuration from cwd.
It received a sterile environment, explicit synthetic application/version/executor,
fresh schema, allowlisted two queues, four-connection owned Unix-socket pool,
disabled admin server, Cloud mode, OTLP, tracing and LISTEN/NOTIFY. No native agents,
providers, project data, credentials, shell workflow bodies, or public listener.
This is configuration/source isolation, not an OS-level outbound network audit.

The outer runner retained its60-second child limit, stopped the owned cluster,
verified pid/socket absence and removed its exact temporary child. The downloaded
candidate/package cohort remains for further comparisons under the existing ledger.

Not tested: process crash/recovery, simultaneous workers, canonical claims or review
authorization, native start uncertainty, schedules, target PostgreSQL17, production
roles, real agents, or performance. Separate earlier client reconstruction is not
process-recovery evidence. Independent review in `f1-dbos-worker-review.md` finds
no material blocker to this narrow evidence; root accepts that disposition.
