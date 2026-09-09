# Calendar comparison: root disposition and migration constraint

2026-09-08. Read the actual six-case fixture/receipt, scheduler call-site report,
and current `src/services/v1/recurrence.ts`. No new calendar run or application edit.

The findings change integration scope: queue selection does not automatically
select calendar semantics. Current Control Room keeps one local-wall-time key for
a repeated fall-back minute, skips nonexistent spring minutes, uses OR for two
restricted day fields, and expands range steps from the range start. The tested
candidate behaviors differ in concrete ways. Existing schedules must not silently
change meaning when a work engine is replaced.

Do not label pg-boss as shifting spring execution solely from cron-parser.next().
Its actual timekeeper calls prev(); the separate probes and inspected age predicate
are the relevant source inference. Neither those probes nor DBOS's synthetic
nextWakeupTime/match loop execute actual schedule delivery, backfill or durable
occurrence materialization. The missed-window enumeration is not proof either
daemon recovers all missed work.

## Required plan direction, not yet a component selection

Keep canonical schedule/occurrence identity and policy distinct from operational
queue job IDs. Compare the maintained cron-parser's public parsing/matching APIs
as a replacement for current custom grammar expansion; do not retain a generic
custom parser merely because a library has different defaults. A narrow policy
adapter may preserve skip/repeat handling and validation without owning a second
scheduler. Its exact supported API and compatibility cases still need inspection.

The eventual acceptance includes recurrence output through the actual occurrence
store/outbox with overlapping windows, restart, repeated DST minutes, changed
schedule definitions and stale/replayed materialization. The current in-window
seenLocalTimes set is not durable cross-window deduplication by itself. Inspect
store replay/conflict behavior rather than assume a second calculation with the
same local key is automatically an accepted replay.

Do not silently relax the accepted cron grammar or migrate historical identifiers
to backend UTC IDs. If a richer grammar or different DST policy is desired later,
version that change explicitly and preserve old schedules' semantics. This is not
a requirement for DBOS or pg-boss to implement Control Room's authority internally.
No candidate has been selected or rejected as a whole by these calendar results.
