# Reuse comparison program and goal prompts

2026-09-08. Baseline `0c2d108`. Owner asks for actual integration-fit comparisons
across remaining outcomes, followed by an actionable implementation plan.
This document prepares that work; it does not claim the comparisons are complete.
The old expired overnight goal is not resumed by drafting these prompts.

Execution checkpoint: the owner subsequently activated Goal prompt 1. See
[current progress](REUSE_COMPARISON_PROGRESS.md) and the
[candidate index](research/reuse-comparison-index.json). Several real-code and
mounted-fit experiments now exist; the overall comparison remains incomplete.

## Direct answer: has every option been properly evaluated?

No. The [26-area map](REMAINING_WORK_REUSE_MAP.md) is a coverage index and shortlist,
not a completed comparative evaluation. The word "evaluated" there includes source
inspection as well as executed experiments. Use the more precise ladder below.

| Existing evidence | What it establishes | What it does not establish |
| --- | --- | --- |
| pg-boss E01/E02 and later application integration | Pinned package behavior, disposable real PostgreSQL concurrency/roles/restart cases, application integration evidence | Complete current-schema real-PG workflow, continuous native fleet and deployment acceptance; superiority over untested contenders |
| Herdr v0.9.0 | Pinned code/license inventory, read-only adapter, real disposable server with cat panes, disconnect/restart/duplicates | Real agent lifecycle, production registration, Windows/SSH, complete redistribution clearance |
| Hermes E07/E08 | Pinned retrieval code executed with a local synthetic channel; file policy cases | Actual remote backend, retained Control Room run-bound artifacts or all live runtime behavior |
| Hermes Desktop E04 | Specific pinned React components and incompatibilities inspected | Mounted adaptation or browser usability comparison against WebUI/current UI |
| ssh2 E55–E58 | Pinned signing-protocol/disposable-key and application packet experiments | Real owner custody, installed consent surface or authenticated delivery |
| etcd E69–E75 and current adapter | Pinned client/protocol and scripted transport; identified restore-domain limitation | Real independently placed service, transport/custody or recoverable production integration |
| Other named candidates | Discovery/source observations of varying depth | Equivalent prototype, benchmark, licensing closure or defensible winner |

Prior tests are reusable evidence at their exact pin and scope, not tests to repeat
for ceremony. Re-run when code/version/environment or the tested requirement changes.

## Evidence ladder

- **E0 Discovery:** repository/feature description only.
- **E1 Source inspected:** immutable pin, relevant implementation and upstream tests
  read, dependencies/licenses traced, constraints documented.
- **E2 Upstream exercised:** actual selected package/module/binary executes with
  disposable inputs; test harness and failures retained.
- **E3 Control Room fit proven locally:** actual candidate crosses our existing
  representative interface with shared acceptance cases, not a look-alike fake.
- **E4 Target acceptance:** actual supported host/database/browser/live workflow
  evidence under separate authorization.

Report evidence per feature and platform, not one badge for an entire repository.
A scripted transport may prove encoding but not a remote service. Passing source
assertions does not prove interactive UI. A mock agent cannot qualify real execution.

## Scope and discovery stopping rule

Account for every A1–D5 outcome in the map. Split broad outcomes into responsibilities
where candidates address different things: queue vs workflow recovery vs terminal
hosting; conversation UI vs multi-agent turn execution; artifact transfer vs custody.

For each responsibility, record every relevant project already discovered, including
unselected alternatives. Perform focused additional discovery for uncovered needs
and credible competing implementations. Log queries, sources, date and reasons for
including/excluding candidates. It is not possible to prove that every repository
on the Internet has been found; make the surveyed set explicit rather than claim that.

Screen every known relevant candidate at E1 unless its exact license, missing source
or documented unsupported interface supplies a decisive exclusion. Do not reject
using a README-only impression, ecosystem unfamiliarity, generic security objections,
or because we already wrote code. Conversely, do not build a clearly unsuitable
platform simply to fill a test-count quota.

Every viable contender that could change the decision gets E2/E3 for the same named
behavior. Normally expect two or three contenders, but do not use that as an arbitrary
cap excluding a better known option. If only one survives, document each exclusion.
Record unavailable platform/resources as untested, never failed or passed.

Stop discovery for a responsibility when the known candidates are dispositioned,
focused searches no longer reveal a materially different viable implementation,
and direct tests discriminate the finalists. Reopen only for a named unmet need or
material upstream change. Do not turn this into an endless repository census.

## Comparison workstreams and required fit experiments

These are evaluation families, not permission to deploy all their members. Reuse one
candidate dossier across several outcomes, but test each materially different seam.

| Family / outcome coverage | Candidates and existing baseline to compare | Required representative comparison |
| --- | --- | --- |
| F1 Queue, continuous work, schedules — A5, B1, B2 | Installed pg-boss; DBOS; Hatchet; existing native dispatch/capacity services | Same canonical task/attempt IDs, SQL commit/rollback and revocation, concurrent eligible claims, review wait without blocking unrelated jobs, duplicate delivery, ambiguous start, schedules/DST/downtime, drain/restart. Compare entire integration and migration cost, not each demo's throughput alone. |
| F2 Native execution and files — A5, B3, B6, B8, B9 | Official Hermes run/room/file interfaces; supported Codex interface shortlist; existing adapters; Herdr only for features it actually supplies | Exact native identity/result/usage mapping, lifecycle/stop semantics, bounded file-to-project bridge, permission checks and resume uncertainty. Use actual parsers/clients with synthetic local peers first; native provider/credential tests remain E4 and require separate authority. |
| F3 Project, conversation, terminal and attention UX — A6, A7, B5, C1, C2 | Existing React UI; Hermes Desktop components; Hermes WebUI modules; Herdr; Studio only where license permits | Mount real selected components against the same disposable project/session data and existing protected API seam. Test navigation/keyboard/mobile, close-view versus stop-work, offline/stale/duplicate state, logout cache isolation, reconnect and rendering cost. Measure adaptation needed to remove Electron/Python/global settings dependencies. |
| F4 Multi-agent teamwork and coding workspaces — B7, C1, C2, D5 | AI Maestro; Agent Orchestrator; native Hermes rooms; existing Idea/jobber coordinator | Real selected code handles a bounded synthetic discussion or messaging/workspace handoff. Establish task ownership, duplicate messages, disconnected participant, turn/budget cap, isolated workspaces and promotion to existing project/task services. Distinguish messaging from scheduling and Git automation from authorized merge. |
| F5 Owner custody and integrity — A3, A4 | ssh2/OpenSSH-agent route versus applicable platform custody; etcd versus OpenBao; existing review/approval/checkpoint contracts | Disposable signing bytes through actual intake; wrong key/changed consent/late reply. Actual candidate CAS where authorized: contention/restart/lost response, independent-restore boundary and split-commit recovery. Never claim local dual stores prove independent production custody. No ambient keys, Keychain or real identities. |
| F6 Installation, supervision and update — A1, B4, B6, D3 | Actual OS supervisors; WinSW versus Task Scheduler; upstream packaging patterns from Hermes/WebUI/Herdr; current compiled entrypoints | Render and validate package/config, run inert artifact where permitted, prove stop/drain/restart and journal preservation, version overlap/rollback, and footprint. A parsed Windows service template is E1, not Windows process acceptance. |
| F7 News/content workflows — C3, C4, C5 | Already integrated Control Center modules and actual tests; Hermes retrieval/presentation; existing ABS/content/Idea task mapping; focused new search only for uncovered behavior | Real borrowed collector through disposable HTTP/data fixtures into current research-task API and results. Compare duplicated ranking/parsing code and removal opportunities; source verification, archive repeatability and provenance preserved. Separate later content/media/harness packs from required Idea/ABS delivery. |
| F8 Identity, backup, monitoring, validation — A2, D1, D2, D4 | Existing Access approach vs Authelia only for actual missing behavior; PostgreSQL tools vs pgBackRest; Kuma and Beszel as complementary tools; current browser/test tooling | Configuration/auth-boundary fit, isolated database restore with roles/rows and artifacts, private health probe and alert, memory footprint, resource limits and restart behavior. Actual Access account changes and VPS restore are separate E4 work, not necessary to compare source fit. |
| F9 License, public package and contribution — D5 plus all families | Every selected upstream, transitive/vendored/build assets, existing Apache distribution and notices | Trace exact imported/executed/shipped files, obligations and changed-file notices; distinguish separate service from copied code. Verify synthetic examples, clean package boundaries and selective CI. Root license or stars are not readiness evidence. |

Do not limit a candidate to the row where we first found it. If source inspection
reveals another useful implemented module, map it to the corresponding outcome and
evaluate its seam. Do not give it blanket approval because another module passed.

## Mandatory candidate dossier

Each candidate-responsibility pair must record:

1. Exact repository, commit/release, source files/functions and upstream test paths.
2. Actual code path, dependencies, runtime processes, storage writes, network and
   credential boundaries; how it works beyond its README.
3. License/notice findings for exact shipped scope, unresolved dependencies/assets
   and whether use is a package, separate service, adapted source or reference only.
4. Current Control Room files/interfaces it would replace or call, with input/output
   mapping and concrete mismatch list. Point to source, not just architectural prose.
5. Prototype path, exact commands, fixture data, environment, outcomes and failures.
   Upstream tests read versus run; candidate real versus mocked parts; E0–E4 by scenario.
6. Adapter size, upstream modifications, dependency/service additions, files/lines
   eligible for deletion, migration/backfill needs and rollback. Zero deleted code
   is acceptable when avoiding new infrastructure; label that honestly.
7. Measured startup time, memory and relevant latency under the same workload,
   including resource limits and measurement scope. Unknown values remain unknown.
8. Maintenance: release/issue/security signals, breaking changes, pin/update strategy,
   test quality, unsupported hosts and likelihood of carrying a fork.
9. Alternatives, comparative decision and explicit confidence. "Best fit" means best
   evidenced among the surveyed viable set, not mathematically best on the Internet.

Store machine-readable inventory at `docs/research/reuse-comparison-index.json`
and human-readable dossiers under `docs/research/reuse-comparisons/` when the goal runs.
These were required outputs at program creation; their current existence and
evidence status are tracked by the progress report, not implied complete here.

## Decision rules

First pass/fail intended-use licensing, essential capability, security/authority and
deployment constraints. Then score surviving contenders 0–5 with evidence and unknowns:
fit 30%, total integration/migration effort 25%, custom code/operations avoided 20%,
maintenance/upgrades 15%, measured resource cost 10%. Publish explanations and ranges;
do not convert unknowns to zero or pretend a weighted score proves correctness.

Include **keep existing code** and **minimal new adapter** in every cost comparison.
Reuse is preferred, not assumed cheaper regardless of integration debt. Count ongoing
fork maintenance, duplicated state, new services and licensing work, not just initial
copy time. Prefer upstream-supported interfaces and narrow adaptation over forks.
Do not preserve unnecessary custom machinery merely because it already exists.

Possible decisions: adopt unchanged, adapt narrowly, retain current, combine distinct
components, reject with evidence, or conditional pending a specified E4 gate. No
winner may be called fully qualified while its decisive test is unrun.

Independent review should challenge the winning adapter, at least the strongest
rejected alternative, test fidelity and the proposed removal/migration path. It must
not be a ceremonial approval of a summary; findings need disposition and recheck.

## Required action plan after comparison

Produce `docs/REUSE_IMPLEMENTATION_PLAN.md` with all 26 outcome IDs covered and any
newly discovered subrequirements traced. For each sizeable implementation batch:

- Chosen component/version/files and rejected alternatives with linked evidence.
- Exact Control Room modules to adapt/retain/delete; data ownership and migration.
- Dependency ordering, parallel-safe scopes, integration owner and review boundary.
- Acceptance commands and complete user journey; separate local vs live evidence.
- Platform and prerequisites visible before any worker claims it.
- Relative effort range, uncertainty drivers and resource/operating cost.
- Rollout/drain/rollback and upstream update strategy.
- One consolidated list of owner inputs, live permissions and unavailable host gates.

Sequence by usable outcomes: first task/result/revision; continuous productive fleet;
real Idea Lab and ABS; recovery/daily use. Start backup/operations work early.
Provide substantial work packets, not dozens of cosmetic microtasks. Keep a justified
custom-code exception register with alternatives and an exit/removal strategy.

Evaluation completion means all known candidates have a disposition, all viable
decision-changing contenders have representative fit evidence, and the action plan
is build-ready for local work. Explicit unperformed live gates may remain; unresolved
decisive *local* comparisons may not be hidden as "deferred" to claim completion.

## Goal prompt 1 — comparison to build-ready plan

Copy the following as a new goal only when ready to authorize its stated scope:

```text
Complete the Control Room reuse comparison program in docs/REUSE_COMPARISON_PROGRAM.md
and all outcomes in docs/REMAINING_WORK_REUSE_MAP.md. This is a new work authorization,
not an extension of the expired overnight window. Work until the defined evaluation
and build-ready implementation-plan deliverables are complete, or no in-scope work
can continue without a specific missing permission or input.

Act as lead architect. I authorize bounded independent research/prototype/review
subagents with non-overlapping scopes. Evaluate every known relevant candidate and
search for strong alternatives where coverage is missing. Inspect pinned actual
implementation, dependencies, licenses and tests, not just READMEs. Exercise actual
viable candidate code through representative existing Control Room interfaces and
compare it with other viable contenders and retaining our current implementation.
Reuse prior valid evidence rather than repeating unchanged tests. Preserve failures.

I authorize public read-only source research and required isolated evaluation downloads.
Check storage first, log every acquisition, use owned temporary roots, cap retained
evaluation downloads at 4 GiB and stop downloads below 20 GiB free. Dependencies must
be isolated from the production application, with install scripts disabled unless
separately reviewed and authorized. I authorize short-lived disposable local test
services using synthetic data and explicit local-only endpoints, including a temporary
PostgreSQL test instance; do not attach to any existing database or agent service.
Run memory-heavy services sequentially, bound execution and resource use, and stop
before threatening host stability. If a test needs broader access or resources, record
the exact need and continue other eligible work. Remove only owned test data/downloads
after saving sanitized evidence and confirming owned processes have stopped.

No real agent/provider calls, personal credentials or profiles, Keychain operations,
SSH to my machines, production changes, persistent services, public listeners, GitHub
writes or Actions. Keep application behavior unchanged; use research-only prototypes.
Keep local checkpoints and preserve unrelated files. Do not weaken security contracts
or licensing requirements to manufacture a winner, and do not assume login authorizes
execution or queue retries make external effects exactly-once.

Deliver the candidate index, code-level dossiers, reproducible fit experiments,
comparison decisions for every remaining outcome, dependency/license and cleanup
records, justified custom-code exceptions, and docs/REUSE_IMPLEMENTATION_PLAN.md.
The plan must name exact components/files to adopt, adapt, retain and remove, migrations,
large implementation batches, tests, rollout/rollback, remaining live gates and a final
copy-ready implementation goal prompt tailored to the actual decisions. Independently
review high-risk conclusions and the strongest alternatives. Do not claim completion
from source inspection alone or stop after producing another shortlist.
```

## Goal prompt 2 — implementation after accepting the comparison

This is a template, not permission to skip unfinished comparisons. The final evaluation
must replace general references with its actual decisions and unresolved gate list.

```text
Implement the accepted docs/REUSE_IMPLEMENTATION_PLAN.md for Control Room. First verify
that its decisions are supported by the completed comparison evidence and match current
source. If a decisive comparison is missing, complete it before importing that component.
Work in substantial end-to-end batches until all authorized implementation and local
acceptance work is complete; do not stop after individual small tasks.

Act as lead architect and integrator. I authorize bounded build and independent review
subagents in non-overlapping scopes. Prefer the selected upstream packages, modules
and services with thin adapters. Preserve licenses and notices, pin dependencies,
remove superseded custom code only after parity/migration tests pass, and avoid
unnecessary forks. Keep one PostgreSQL work authority and the accepted approval,
project, attempt, result and review boundaries. Do not reduce the requested product
to a demo or count synthetic agents as live fleet acceptance.

Finish the first task/result/review/revision path, continuous eligible fleet work,
multi-bot Idea Lab-to-project work, ABS article-to-research results, and the planned
installation, monitoring, backup/restore and update/recovery integration. Preserve
later optional modules as explicitly scoped in the plan rather than silently dropping
them or making every future harness a prerequisite for the first usable release.

Work locally with logged, isolated dependency acquisition and disposable tests within
the comparison program's resource limits. No real credentials, provider calls, native
owner-attended operations, remote host changes, production database operations,
persistent installations, deployment, GitHub writes or Actions without separate exact
authorization. Prepare complete operator packets for those gates and continue other
eligible implementation. Never recycle a spent one-shot qualification authorization.

Verify each batch in proportion to risk, obtain independent review for security,
migrations and lifecycle changes, keep local commits, update the outcome/evidence
matrix and maintain an exact remaining-gates list. Finish with installable artifacts
and instructions for each supported host, local acceptance evidence, rollback paths
and a consolidated operator handoff. State separately what is implemented, locally
tested, target-qualified and operational. Do not mark Control Room finished while
required live acceptance remains unproven; report the precise next authorization.
```

No evaluation services or new downloads were run to draft this program. Existing
evidence was inspected locally. This document supersedes the implication that a
shortlist alone is a completed comparison; it does not select new dependencies.
