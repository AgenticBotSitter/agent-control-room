# E43 — verified saved-plan readback

2026-09-06. Local integration; no deployment or external runtime activity.

Task planning now has an optional scoped readSaved capability. The trusted planner
reuses its existing source validator, signed-plan verification and canonical bundle
check to return only the historical receipt. It checks current task/project/session
access, but does not require today's template to match or remain unexpired. No plan
creation, assignment, approval, execution, schema repair or raw plan/key exposure occurs.

GET of the existing task plan route can return already_planned and the saved receipt.
The browser captures this receipt after a current protected read, so a new page/client
recovers the prepared-task link. A matching read can resolve an uncertain prior reply
without a second POST; it does not clear another task's pending command or mutate an
in-flight command's identity. Older compositions without readSaved retain their previous
availability behavior rather than falsely claiming that no plan exists.

Needs Me first completes its owner-authorized web query, then uses separate bounded
coordinator operations for at most 25 proposal receipts. This deliberately avoids
holding the web identity lock while calling another pool that must acquire the same
lock. Every receipt read performs its own current authorization. This is a sequence
of authorized observations, not a single fleet-wide transactional snapshot.

Only a verified same-project/source receipt removes a proposal reason. Failed reads
make the response unavailable rather than silently dropping tasks. Prepared non-proposal
jobs are labeled for assignment, not replanning. The response/UI explicitly reports
whether saved-plan checks are configured. The stable scan cursor remains valid when
all candidates on a page are already planned; the next page can still be requested.

Verification: 48 focused planner/lifecycle/browser/attention checks pass. They include
historical reads after template change/expiry, rejection with a wrong verification key,
source uniqueness, restricted web SQL lacking direct plan access, shared logout,
inbox removal plus prepared-task retention, fresh-client receipt recovery and lost
reply reconciliation with one POST. An initial corruption test tried to UPDATE an
append-only table and was correctly rejected; the final test preserves that refusal
and separately uses an incorrect test verification key. No trigger was disabled.

TypeScript and targeted lint pass. VPS build, all three compiled full-host journeys
and all 35 compiled regressions pass. Existing test suites already include these
files; no dependencies, grants or migrations were added.

Remaining: task-specific delivery uncertainty and exact assignment/approval readiness,
interactive browser acceptance, real PostgreSQL and live agent qualification. This
does not turn the inbox into a scheduler or close fleet/Idea Lab/ABS/daily-use milestones.
