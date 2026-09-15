# Public build flow measurement

This is the operating contract for measuring whether Agent Control Room work is
actually moving. A claimed issue or open pull request is not counted as active work.
The system separates reported work time from GitHub waiting time so a full-looking
queue cannot hide an idle build.

## The three primary measures

1. **Reported flow coverage:** percentage of the selected operating window covered by
   at least one tightly bounded, self-reported worker, reviewer or lead work session.
   The target is 100% of a deliberately staffed window. It is not called 24/7 coverage
   until persistent workers have actually been scheduled for all 24 hours.
2. **Accepted substantial outcomes:** merged feature or integration packages per day
   and week. Commits, comments and tiny procedural fixes do not count as delivery.
3. **Avoidable waiting:** actionable work older than its response target, grouped by
   queue pickup, worker implementation, reviewer, worker correction, integrator,
   lead/owner decision or external dependency.

Quality is a guardrail, not something traded away for activity. Read first-pass
acceptance, correction rounds, closed-without-merge work and recorded post-merge
defects beside the three measures above.

## Sources and honesty rules

| Signal | Source | What it proves |
| --- | --- | --- |
| Claim, submit, correction and acceptance times | GitHub controller records | Objective workflow transition time, not active model time |
| Pull-request creation, update and merge | GitHub | Objective repository activity, not continuous work |
| Model, effort, tokens, calls and interruptions | Contributor report | Best available self-report; missing stays unknown |
| Work-session start, end and active minutes | Contributor report | Reported active work only when the time window is tight |
| Current issue state and last activity | GitHub labels and timestamp | Who should act next and how long the record has been quiet |

Never infer active work from a claim, branch, green check, open pull request, watcher
process or online machine. A watcher can detect work; it cannot wake a stopped agent.
Token counts are exact only when the provider reports them. Do not derive them from an
account usage percentage.

## Record one phase without creating comment noise

Workers add these fields to the one pull-request handoff they already make:

```text
Worker-Started-At: 2026-09-15T10:00:00.000Z
Worker-Ended-At: 2026-09-15T12:30:00.000Z
Worker-Active-Minutes: 150
```

Start when implementation begins. Stop before waiting for the owner, another worker,
review, provider access or a usage reset. If work resumes after a long wait, report the
combined active minutes but use `unknown` for start/end because one broad interval would
falsely claim continuous coverage.

Reviewers and the lead append one existing `acr-contribution-metrics:v1` record when a
review, correction decision, packet-design phase or integration phase finishes. Start
and end must bound active work, not the time a task sat in a queue. One record at the
normal handoff is enough; do not post 30-minute heartbeat comments.

Only phase records posted by the configured maintainer role account and bound to the
matching issue or pull request affect the report. The public repository defaults to
`AgentControlRoomMaintainer`; a fork can add its own role account with a repeatable
`--trusted-login ACCOUNT` option. Worker timing counts only when the pull-request
author matches the worker identity in exactly one controller-accepted claim and the
reported work starts no earlier than that acceptance. Untrusted,
unbound, duplicate and malformed records are excluded and reported separately.

## Current response targets

These are provisional operating alarms, not promises about task difficulty:

| State | Responsible area | Alarm after no GitHub activity |
| --- | --- | ---: |
| Ready | Queue pickup | 60 minutes |
| Working | Assigned worker | 4 hours |
| In review / Re-review | Reviewer | 60 minutes |
| Changes required | Original worker | 60 minutes |
| Accepted for integration | Integrator | 60 minutes |
| Needs decision | Lead or owner | 60 minutes |
| Waiting | Named dependency | 24 hours |

A configured monitor should check every 30 minutes. The project does not claim that a
monitor exists merely because this report exists. When an alarm fires, it reports the exact issue and
responsible area. The response is to repair the missing packet/handoff, supply the
decision, review the submission, or expose another non-overlapping Ready package—not to
create artificial activity.

## Read the report

```sh
pnpm flow:report
pnpm flow:report -- --trusted-login YOUR_MAINTAINER_ROLE_ACCOUNT
pnpm model:costs -- --window-hours 168
pnpm model:costs -- --window-hours 24 --json
```

The report shows reported coverage, active agent-minutes, the longest unreported gap,
missing or unusable timing, and current overdue bottlenecks. It also retains the
delegated-versus-direct comparison. Do not declare a winning model or work method until
there are at least five accepted, comparable outcomes on each side.

## Improvement loop

The [daily activity procedure](DAILY_BUILD_ACTIVITY.md) extends this report with
per-worker elapsed-day and declared-availability percentages, explicit idle/blocked/
offline/unknown time, and a two-hour diagnosis/action/result loop. It reuses the cost
and outcome reports below; it does not infer idle time from missing work reports.

At least daily, and after any idle night:

1. Find the largest avoidable waiting bucket.
2. Fix that bottleneck before adding more workers.
3. Maintain at least four substantial non-overlapping Ready packages when unfinished
   work can safely proceed.
4. Review or return completed work before designing new packets.
5. Compare accepted outcomes, correction rounds, active minutes and tokens only within
   similar difficulty, size and risk.
6. Record the change made and check whether the next seven-day report improved.

The first likely bottleneck is orchestration availability: local inbox watchers do not
start sleeping harnesses. Genuine unattended coverage requires the later persistent
worker scheduling and reconnect work; until then, gaps are reported rather than hidden.

No prompt text, account identity, credential, private hostname, billing record, machine
identity or private project data belongs in these measurements.
