# E42 — saved task attention with verified review state

2026-09-06. Local implementation; no deployment, provider, listener or GitHub activity.

Needs Me now includes task-specific links from GET /api/v1/needs-me/tasks. This is a
read model of existing canonical task and completion-gate records, not a second queue
or custom workflow engine. Existing task result/review verification is extracted into
a shared in-session helper and reused unchanged by the task results page and inbox.

Candidate selection is tenant/workspace-scoped, limited to supported ordinary/Idea
project sources, and requires wildcard owner tasks.read plus matching project-source
access. Each returned project and task is checked inside the same session/grant
transaction. Source exclusion or missing Idea configuration is explicitly reported.
No result text, raw node identity, checkpoint or command capability is returned.

The list identifies proposals, waiting approvals, failed/orphaned tasks, pending
reviews, requested changes, blocked verification and revision limits. Incomplete
result/review configuration or omitted/unmatched evidence is flagged, never treated
as completion. Review labels derive from verified matching targets, not loose artifact
existence. A review acceptance alone does not remove an item if required verification
is still pending; a ready review does. Existing canonical job state is not rewritten.

Pagination examines 25 candidates at a time using a stable job-ID cursor. A page can
contain zero visible items while still offering a next page because completed reviews
can occupy candidate rows. This is explicitly not an all-clear. Refresh starts again
from page one; failed reads hide old data. The shared attention browser reader uses
bounded bytes/time, same-origin GET and strict response/cursor validation. Links open
ordinary task pages and never approve, retry or execute anything.

Verification: 14 combined attention/result checks pass, including 26-task pagination,
owner-only enumeration, logout, invalid scope/cursors/methods, result acceptance pending
verification, and removal only after both required records exist. All three actual
package source and compiled full-host journeys expose the returned pending-review task
through the new route. TypeScript, targeted ESLint, VPS build and 35 compiled regression
checks pass. Final schema-refinement/source rerun also passes.

Initial test mistakes are not product waivers: an omitted review idempotency key was
corrected; an attempted empty verification requirement was rejected by the existing
profile contract. The final test records the required independent verification rather
than weakening that contract. New tests join the normal posttest command.

Still remaining: task-specific queue delivery uncertainty/held work and exact approval
or planning readiness. These are not established by canonical proposal state. A proposal can
already have a separate execution plan; the UI explicitly says to check planning status.
The UI states the queue gap;
the E41 aggregate remains separate. Browser interaction and real-agent/private-PG
acceptance, fleet, Idea Lab, ABS and daily-use operations remain open.
