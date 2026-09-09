# F1 calendar primitives: actual DST and occurrence fit

2026-09-08. Existing installed DBOS4.27.6, pg-boss12.30.0 → cron-parser5.10.0 → Luxon3.7.2. Source-only scheduler inspection plus E2 calendar execution. No package downloads/install, database/service/worker, native calls, wall-clock monkeypatch, or production changes. No scheduler-delivery/durable occurrence E3 is claimed.

## Result

**Neither scheduler's unadapted calendar/identity behavior is a drop-in replacement for Control Room's current occurrence semantics.** The differences are concrete, not a reason to reject either queue system or write a new generic scheduler. Preserve canonical occurrence policy separately until root decides the smallest library adaptation. In particular, pg-boss uses the parser's **previous** occurrence, not next; calling next() alone gives a misleading DST comparison.

| Shared input | Actual DBOS TimeMatcher enumeration | Actual cron-parser next enumeration | Actual existing CR calculator |
| --- | --- | --- | --- |
| UTC every15min00:00–01:00 | 00:00/15/30/45 | Same | Same |
| Denver nonexistent02:30,2026-03-08 | No occurrence | Shifts to03:30 local /09:30Z | No occurrence |
| Denver repeated01:30,2026-11-01 | Both07:30Z and08:30Z | First07:30Z only | First07:30Z, stable local-time key |
| UTC every5min bounded missed window00:00–00:18 | 00:00/05/10/15 | Same | Same |
| `0 9 1 * 1` on MondaySept7 | No match: restricted DOM AND DOW |09:00: restricted DOM OR DOW |09:00 |
| `1-5/2 * * * *` | Minutes2/4 | Minutes1/3/5 | Minutes1/3/5 |

These are six executed common cases, not six universal compatibility passes. Output preserves all candidate differences. Only some expected parity/negative behaviors are explicit fixture assertions; the complete arrays are direct recorded observations. No calendar normalization was added to force equality.

### Actual pg-boss call-site correction

`dist/timekeeper.js:199–204` calls `CronExpressionParser.parse(cron,{tz,strict:false,currentDate:databaseTime}).prev()` and compares its age to60seconds. It does **not** enumerate next() or replay an arbitrary missed range. Five additional actual prev() probes, separately captured, show:

- Spring hypothetical shifted03:30:30 local: previous is the prior day's02:30, age86,430seconds. Thus the source's age test would not send the nonexistent spring occurrence here; next()'s shifted output must not be attributed to that pg-boss branch.
- Fall first01:30:30 and second01:30:30: previous equals each respective UTC instant, age30seconds each. Source inference: both satisfy the branch's age predicate. Actual queue insertion/delivery was not run.
- Missed00:18 poll: previous00:15, age180seconds; near00:15:30 poll: previous00:15, age30seconds. Source inference: old missed occurrence is outside the current tick window. This is not a measured outage/backfill claim.

`timekeeper.js:191` uses queue/key singleton60seconds. That source policy is not the same as CR's permanent tenant/schedule/local-wall-time occurrence identity. No mutation or scheduler clock substitution was needed to expose the distinction.

## Actual DBOS call path and limits

`dist/src/scheduler/scheduler.js:147–203` constructs TimeMatcher and repeatedly calls nextWakeupTime then match, because a returned wakeup may be merely a conservative checkpoint, not an occurrence. Its occurrence workflow ID incorporates schedule name plus UTC date. The fixture follows that next/match usage and starts one second before the inclusive comparison boundary; the synthetic loop is not the actual scheduler loop. `backfillSchedule:252–281` similarly enumerates between bounds and enqueues; only source was read, not enqueued.

`crontab.js:TimeMatcher` scans up to3,599seconds per call. It uses Intl/IANA formatting and requires both restricted day fields; range-step conversion tests absolute divisibility. All comparisons ran with explicit process TZ=UTC and requested schedule zones, avoiding dependence on this Mac's local zone. This does not prove behavior under every host TZ or historical timezone database version. No workflow status, last-fired record, idempotency check, backfill storage, restart or failure/retry loop executed.

## CR requirements actually present

`src/services/v1/recurrence.ts` requires bounded [start,end) windows, five-field cron, current expression semantics, skip nonexistent wall time and one local-time key across fall repetition. `tests/services-v1-recurrence.test.ts:10–15` explicitly asserts the spring/fall policy. The calculator also handles once/anchored interval and paused/invalid/oversized inputs; those branches were source-inspected, not rerun here.

`occurrence-store.ts:42–54` atomically materializes occurrence/outbox with tenant/schedule/key and exact-replay/conflict checks; delivery acknowledgement requires a delivered outbox. Existing occurrence-store tests cover those claims. They were read, not executed. Calendar output itself cannot replace approval, tenant/project authority, durable replay checks or review waiting. No new requirement for a queue to own CR's canonical IDs is imposed.

## Reuse/removal cost

DBOS has real scheduler/backfill machinery that could avoid authored wake loops in a future queue decision; its UTC occurrence identity and grammar differ from CR. Do not silently change prior schedule meaning to fit it. Direct adoption of this internal TimeMatcher as the CR calculator would require policy-aware adaptation or documented scope restrictions, and an internal SDK file is not automatically a supported standalone public API.

cron-parser already exists through pg-boss, supports the current OR/range-step semantics, but next/prev DST behavior requires a deliberate finite policy test before replacing CR's minute scanner. Reusing the parser plus retaining canonical local-key/skip policy is a credible narrow option, not a selected implementation here. Retaining the entire custom parser merely because candidate defaults differ would also be premature. Existing pg-boss delivery or DBOS backfill still needs durable occurrence/approval integration.

No current file is removal-approved by this experiment. Possible replacement boundary is the standard cron parsing/calendar search portion of recurrence.ts; retain bounded API, state handling, existing occurrence keys, canonical store and task authority. Root must select any actual policy adapter after an E3 recurrence→occurrence/outbox comparison; that does not require another unchanged calendar experiment.

## Provenance, resource and cleanup

`f1-calendar-pins.json` guards45 actual source/package files before import: DBOS matcher/scheduler, pg-boss timekeeper, complete cron-parser dist and Luxon Node build closure, CR calculator/store/tests. Version assertions establish DBOS4.27.6/pg-boss12.30/cron-parser5.10; actual Luxon3.7.2 is recorded. These are existing installed-package source hashes, not a new remote provenance verification. DBOS's matcher retains an ISC/node-cron file notice despite the package's MIT root; pg-boss/cron-parser/Luxon declare MIT. No shipping/license closure is claimed.

Repository stagezero passed effect-free readiness. Actual captures use bounded subprocesses (30seconds/1MB, and10seconds/100KB), sterile PATH/TZ and no services. The six-case measured loop took94.44ms; this is a tiny combined fixture timing, **not a comparative production benchmark or RAM measurement**. Receipts retain actual stdout/exit0. No failed setup/fixture and no focused repair occurred. The five-probe follow-up did not repeat the six-case enumeration. Zero new downloaded bytes, zero temporary roots to delete; existing DBOS research root and app dependencies were left untouched. Both short Node processes completed. Root retains architecture/selection/acceptance.
