# Daily work, idle time, and improvement

This is the measurement procedure linked by the [contributor handbook](../CONTRIBUTOR_HANDBOOK.md),
not a new claim or approval system. People and bots use the same public process.
The goal is **accepted useful work with less avoidable waiting**, not busy agents or
more comments. Keep quality, permissions and existing ownership intact.

## What each daily percentage means

Every report states the date, timezone, observation cutoff and denominator. Use elapsed
time since local midnight for today's report, and the actual midnight-to-midnight
duration for a completed day (a daylight-saving day need not be 24 hours). Forks choose
their own reporting timezone. Do not divide a partial day by a full day.

| Bucket | Meaning |
| --- | --- |
| Building | Implementing or fixing the product, including direct lead coding |
| Testing | Running or investigating relevant checks |
| Reviewing | Examining someone else's exact submitted work, including re-review |
| Managing | Designing work packets, decisions, handoffs, queue repair and integration administration |
| Idle | Explicitly reported available time with no work being performed |
| Blocked | Explicitly reported waiting on review, a prerequisite, permission, access or capacity |
| Offline | Confirmed unavailable, stopped, asleep or out of service |
| Unknown | No bounded report, missing history or contradictory overlapping reports |

Record implementation done while integrating as building, not managing. Record passive
waits separately from active testing or review. A claim, open PR, green check, machine
uptime or timer installation does not prove active work. A silent worker is unknown,
not automatically idle. Do not retrospectively invent start/end times from chat or
commit timestamps. Self-reported time is not measured CPU or provider inference time.

For each stable worker ID, including the lead, show minutes and percentage of the
elapsed day in each bucket. Show **work = building + testing + reviewing + managing**,
and the build/test versus review/manage split. Unknown remains visible in the total;
never calculate idle as 100% minus work. Merge overlapping identical intervals and
classify conflicting overlap as unknown, rather than counting one minute twice.

Also show work as a percentage of that worker's **declared available window**, with
scheduled minutes and reporting completeness beside it. This distinguishes an expected
24-hour runner from a contributor who volunteered two hours. Availability is a stated
schedule, not proof the worker ran. Missing availability means that percentage is
unknown. Never imply that every public volunteer owes a full day of work.

Team coverage is the union of intervals where at least one worker reported work;
simultaneous workers do not produce coverage over 100%. Agent-minutes can be summed
separately as cost. Team uncovered time is unknown unless its state is evidenced.

## Worker reporting: small batches, no extra gate

1. Keep your existing stable role-based worker ID. On starting a session, capture a
   timestamp and the actual model/effort exposed by your harness; use `unknown` when
   unavailable. Do not repeat a requested model as though routing was verified.
2. Record bounded intervals when you change between work, waiting and stopping. Split
   when the model or effort changes. Do not claim the gap between scheduled sessions
   as active work. A resumed session cannot infer what happened while it was offline.
3. At a normal progress update, blocker, submission or re-submission, include one batch
   of new intervals on the assigned issue/PR. During a long-running session, include a
   short progress-and-timing batch at least every two hours. Use issue #12 for availability
   or no-fit reports when unassigned. No 30-minute GitHub heartbeat spam is required.
4. Retain normal `Worker-Model`, `Worker-Effort` and optional cost fields. Report exact
   provider token counts when available; missing is `unknown`, never zero. Keep reviewer
   model and effort separate. Raw prompts, account usage screens, credentials, private
   paths and host identities must never be uploaded.
5. Missing timing is a measurement gap, not a reason to reject otherwise useful work.
   Correct measurement errors with a clearly identified replacement record; keep the
   original evidence. Never edit a controller marker to add metrics.

Use this **synthetic example** shape in a fenced JSON block; substitute real observed
times and stable IDs. Each interval ID is unique across your reports. Reposting the
same record does not create more work time. Availability is optional and must reflect
a genuinely declared schedule. Unfinished intervals stay local until bounded.

```json
{
  "schema": "acr-daily-activity:v1",
  "workerIds": ["backend-worker-01", "reviewer-01"],
  "availability": [
    {"workerId":"backend-worker-01","start":"2026-09-15T10:00:00Z","end":"2026-09-15T12:00:00Z"}
  ],
  "intervals": [
    {"id":"backend-worker-01-session-1-build","workerId":"backend-worker-01","model":"unknown","effort":"unknown","category":"building","start":"2026-09-15T10:00:00Z","end":"2026-09-15T10:40:00Z","evidence":"self-reported"},
    {"id":"backend-worker-01-session-1-wait","workerId":"backend-worker-01","model":"unknown","effort":"unknown","category":"blocked","start":"2026-09-15T10:40:00Z","end":"2026-09-15T11:00:00Z","evidence":"self-reported"}
  ]
}
```

Explain the wait reason in the accompanying sentence: review, no suitable work,
dependency, provider limit, permission, host unavailable, or other concrete cause.
Do not include personal account/provider access details. An idle report should name
the offers considered and why none fit, so the lead can repair the queue.

## Collection and commands

The lead collects batches during its normal GitHub review. Verify their provenance:
worker reports must match the accepted claim's actor and stable worker ID on that
issue/PR; preserve the GitHub comment permalink as evidence. Reports from reviewers
must match their recorded review assignment; lead reports come from the configured
maintainer role. Unassigned availability/no-fit reports are explicitly self-reported,
not authenticated work. Never trust a copied worker ID alone, especially on shared
accounts. Metrics confer no claim, permission, reviewer authority or merge power.

Keep a local sanitized consolidated JSON file and append evidence at normal handoffs.
Deduplicate identical IDs before aggregation; conflicting duplicate IDs need resolution,
not last-write-wins. Preserve unverified batches separately and list their count and
reason for exclusion. The calculator validates structure and arithmetic, **not identity**:
it does not crawl GitHub or authenticate claims. The lead's scheduled collection step
is required; do not claim worker telemetry is automatic merely because a CLI exists.

```sh
node scripts/public-daily-activity.mjs --input /path/to/sanitized-activity.json --start 2026-09-15T00:00:00Z --end 2026-09-15T12:00:00Z
node scripts/public-daily-activity.mjs --input /path/to/sanitized-activity.json --start 2026-09-15T00:00:00Z --end 2026-09-15T12:00:00Z --json
pnpm model:outcomes
pnpm model:costs -- --window-hours 168
```

Choose explicit UTC boundaries corresponding to the reporting timezone. The first
command reads only the supplied file and emits a report; it does not install a service,
start agents, or change GitHub. Include workers with declared availability but no
intervals: their time is unknown, not absent from the report. Keep expected-but-unreported
workers visible in the summary even when their availability is unknown.
The optional `workerIds` roster supplies those expected IDs without inventing a
schedule: an ID with no reports appears as 100% unknown, not zero idle or zero actual
work. A batch may omit the roster; the lead maintains the combined expected-worker
list. Phase-end reporting can lag current activity; state each source's last observed
end time. Partial known work is a lower bound until missing intervals arrive.

## Cadence and who acts

**Every 30 minutes — operate, then report.** The lead checks current issue/PR evidence,
reviews or routes corrections, merges accepted work in order, repairs broken offers
and refreshes dependents. End every run with a timestamped queue snapshot, actions
taken, daily work/idle/blocked/unknown percentages by worker, and missing data. Show
the lead's building/testing versus reviewing/managing split, not just worker effort.
Report even if nothing changed. Unknown data must not look like zero activity.

**Every two hours — diagnose and intervene.** Compare at least four successful scheduled
snapshots; if checks were missed, say coverage is incomplete. Rank avoidable waiting
using transition times and explicit wait reports, not generic `updated_at` activity
that a harmless comment can reset. Review the largest bottleneck first:

| Trigger (provisional alarm, not a worker performance verdict) | Action |
| --- | --- |
| Submitted or corrected head waiting over 60 minutes | Lead reviews it before authoring more packets; obtain a focused reviewer if useful. |
| Two checks with no fitting valid pickup work for an available worker | Lead checks prerequisites, packets and locks, repairs the offer or releases a real independent package. Never invent filler tasks. |
| Correction not acknowledged after 60 minutes | Lead checks the actual worker inbox/identity and delivery record, not just the label. |
| Available worker has no fresh progress/timing for two hours | Check reports, current PR and scheduler evidence; mark unknown and request clarification through GitHub. Do not steal its branch. |
| Known idle/blocked time exceeds 25% of a declared two-hour available window | Identify the largest cause and remove an authorized blocker. This is an initial investigation threshold, not an established performance baseline. |
| More than 20% of the declared window is unknown | Repair reporting/scheduler evidence before claiming an efficiency gain or blaming a model. |

At a two-hour boundary record: **observation → evidence → suspected cause → action →
responsible role → expected result → next check**. Distinguish hypothesis from proven
cause. Keep at most one primary improvement in progress per bottleneck. At the next
two-hour check, say improved, unchanged, worse, or insufficient evidence. Repeated
failure requires a changed approach, not the same alert. Never weaken safety checks,
clear live locks, automatically swap credentials/models, or bypass owner authorization
to make utilization look better. Owner-only blockers stay visible while independent
work continues. No extra timer is needed: run this inside the existing lead check.

**Daily — summarize results.** On the first successful check after the day ends, report
the completed day and begin today's partial-day counters. Include accepted substantial
outcomes, review waits, avoided/remaining bottlenecks, work/idle/blocked/offline/unknown
time, reporting completeness and improvements actually verified. Retain snapshots in
the lead's run history; post one sanitized daily summary and material procedure changes
on public coordination issue #12. Do not commit a status file or trigger CI every poll.

## Which models and working methods are effective?

Reuse the existing model outcomes and cost reports. Compare **similar size, difficulty,
risk and kind of work**, with actual model/effort, reviewer model, material correction
rounds, accepted outcomes, known active minutes and known tokens. Report missing-cost
sample counts. Keep setup failures, controller failures and lead waiting separate from
implementation defects. A demanding reviewer or harder assignment can increase
corrections without proving a model is worse. Do not rank models by commits or comments.

At least five accepted comparable outcomes per group are needed even for a tentative
recommendation. Show sample size and uncertainty; this is observational, not a causal
benchmark. Never eliminate a model based on one rejection. Compare direct lead builds
with delegated builds using **worker + reviewer + lead packet/review/rework/integration
cost**, not worker cost alone. Missing phases make total cost unknown. Recommend a
specific role/model pairing or bounded trial; do not change anyone's paid configuration.

## What this does not yet prove

This procedure and calculator support an improving work loop; they are not proof of
an autonomous 24-hour build. Worker schedulers must actually start authorized sessions,
the lead must run, and providers/hosts must be available. First prove a real staffed
day with a full claim/build/review/correction/merge cycle and honest coverage. Until
then, publish gaps and repairs rather than promise uninterrupted work.
