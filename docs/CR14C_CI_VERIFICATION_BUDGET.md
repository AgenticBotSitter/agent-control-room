# CR14C — preserve full CI verification within a realistic job budget

Date: 2026-09-05. Build infrastructure only; no product activation or merge.

PR #300 head `396c8a68b2b80bc8ce3f5ef2ebb133965a44b561`, run `33981299049`, job
`101346874671` started at 17:32:54 UTC and completed cancelled at 17:53:11 UTC.
Observed GitHub step records show:

- Preparation, TypeScript and lint succeeded.
- Full test lifecycle succeeded, 17:34:24–17:52:02 UTC (17 minutes 38 seconds).
- Sites build/rendered verification succeeded, 17:52:02–17:52:17 UTC.
- Private VPS build/verification was cancelled, 17:52:17–17:53:07 UTC.
- Database migration verification was skipped.

The workflow allowed only 20 minutes for the entire job. Its observed duration and step boundary are
consistent with that timeout, not a reported failing test. A cancelled run remains non-passing.

Increase the existing finite job timeout to **35 minutes**. Preserve the same single required job,
read-only GitHub permissions, triggers, concurrency cancellation, dependency preparation and all check
commands in the same order. No tests are skipped, retried, marked optional or given continue-on-error.
No package, runner, dependency, runtime or test timeout changes. This adds headroom rather than claiming
faster tests; later profiling/sharding can improve turnaround if measured runs justify it.

Validation compares the complete workflow to the exact parent and requires the one timeout replacement
to be the only difference. A subsequent current-head GitHub run must still prove completion; this
configuration change does not convert earlier cancelled runs into passes, repair old PR checks or
authorize merging them. Existing native/provider/database/deployment gates remain unchanged.

After this infrastructure correction, continue CR14C stop/recovery, trusted current evidence, owner
approval/intake, signed dispatch and revisions on Astra Medium.
