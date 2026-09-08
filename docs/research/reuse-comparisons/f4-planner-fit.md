# F4 mapped pure-planner fit — current Idea semantics preserved

2026-09-08. Baseline `29dbc4a`; no product edits. This resolves a **bounded local
mapping question**, not all F4 acceptance. Actual pinned Hermes pure planning code
was invoked inside the actual Control Room coordinator's synthetic driver port;
real current stores validated/retained contributions and attempt receipts.

## What passed and what did not

Twelve cases:3and6participants ×1,2,3rounds ×unchanged/explicitly adapted planner.
All expected assertions passed. `f4-planner-evidence.json` preserves full mappings.

| Requested current product | Unchanged Hermes | Explicit policy adaptation |
| --- | --- | --- |
|3participants,1round|3 contributions, completed|3 contributions, completed|
|3participants,2/3rounds|Stops scheduling after3; coordinator records ambiguity at next marked turn|6/9 contributions, completed|
|6participants,1round|6 contributions, completed|6 contributions, completed|
|6participants,2/3rounds|Stops scheduling after6; coordinator records ambiguity at next marked turn|12/18 contributions, completed|

Each case reruns the same canonical run ID afterward: exact digest replay, no extra
driver calls. Expected mismatches are recorded as negative fit evidence, not upstream
bugs or actual provider uncertainty. The experiment deliberately checks scheduling
inside the driver, after CR's marker. A production adapter must compare/preflight
planner availability **before** marking a provider attempt; otherwise a local mapping
failure creates avoidable ambiguity. Current unchanged safety behavior was preserved.

## Exact code and mapping

Hermes `fb3446a281e4bddc733a04bf92a5ec5f0d6decc9`:
`gateway/hosted_room_discussion.py`792lines, driver870, rooms1171, common172.
Five files including MIT license162,318bytes. Only pure plan functions used; no SQLite
connection, Hermes gateway, profile or native agent initialized. Python3.12 from
existing bundled runtime. No package install.

`f4-planner-peer.py` receives canonical mapped participant and room event JSON over
bounded subprocess stdin, calls real `plan_next_task` and `plan_publication`, and
returns selected member/round/task ID plus projected events. Source is imported
unmodified for baseline; adaptation executes an explicitly changed in-memory source
copy. No upstream downloaded file was edited.

`f4-planner-fit.ts` constructs valid sessions via `buildIdeaLabSessionV1`, uses real
`IdeaLabBotCoordinatorV1`, `IdeaLabBotRunStoreV1` and `IdeaLabProjectRegistryStoreV1`
over **one disposable PGlite database** with every current migration. No fake storage
or copied coordinator. A repository fake driver produces ordinary structured safe
opinions and provider-receipt digests; candidate selection must match exact current
participantId and1-based round before result reaches existing receipt/contribution
validation. `sessionId→room_id/thread_id`, `participantId→member_id`, explicit synthetic
perspective/profile→profile/handle, `candidate round_index+1→round`.

## Adaptation measured rather than assumed

Four explicit planner policy changes:

1. Set planner round constant to validated current session's1–3rounds.
2. Set message constant to participantCount×rounds (through18).
3. Replace mention-driven responder selection with the complete roster every round.
4. Remove round-based roster rotation to retain current participant ordering.

These changes achieve ordered full-panel parity in the tested ordinary-opinion cases.
They also remove some of the most distinctive upstream collaboration behavior. That
is adaptation feasibility, **not evidence that carrying the fork is worthwhile**.
The helper is23lines, TypeScript fit harness40, acquisition4 (67total physical lines,
several compact). Counts include test orchestration and are not production LOC claims.
The imported792-line planner relies on classes/constants/validators from3,005lines of
source. A packaged Python helper adds interpreter/process protocol maintenance, though
no database service is required for pure planning. A TypeScript port would require
its own parity and upstream-update discipline.

Candidate prompts measured566–964characters. In6-member cases several exceed the
actual existing800-character filtered-driver port. The harness **keeps current
`input.safePrompt` unchanged**; candidate prompt size is measured, not sent or quietly
truncated. Therefore passing selection+receipt mapping does **not** qualify upstream
prompt construction. `discussion-prompt.ts`55lines must remain until a bounded prompt
adaptation preserves the owner brief and all peer excerpts.

Current coordinator327lines includes authority, marker, receipt, cancellation and
cost/time checks. Candidate cannot replace that file wholesale. Concrete replacement
candidate is selection mechanics at coordinator's nested loop (~one line), plus
future open-ended discussion routing that does not yet exist. Current80-line store
and promotion service remain. Production deletion justified now:0lines. A larger
upstream planner is more useful when we explicitly want mentions/pass/defer/replayable
room discussions than when replacing an already simple all-participant loop.

## Scope limits and remaining experiment

Evidence is E3 for **mapped selection through existing synthetic driver/result/stores**,
not a planner-driven outer coordinator replacement. Current coordinator still owns
the loop. Candidate event plans are accumulated transiently before fake result is
accepted; no claim of durable two-log atomicity or crash recovery. A production adapter
must project events from accepted canonical receipts rather than publish speculative
settlement. The mapping's output task IDs are observed, not saved as durable bindings.

No new cancel/cost-stop/forged-event or project-promotion test in this scoped harness.
Prior coordinator and Hermes recovery tests retain their exact scopes, not a combined
cross-language lifecycle guarantee. 4/5participants not separately run; roster bounds
were3/6. No native provider or tools were enabled. The unchanged room-tool-policy
mismatch from the earlier durable dossier remains separate.

Next decisive test, if adopting dynamic discussion mode: put pure planner selection
before marker inside a research-only coordinator composition, derive typed upstream
events solely from accepted CR receipts, round-trip persisted bindings after restart,
and test cancellation/cost caps/stale generation and promotion. That is more work
than a line-for-line scheduling swap and must be justified by desired new behavior.

## Recommendation / plan entry

**Retain current fixed-panel scheduler and bounded prompt code for present Idea Lab;
use official zero-tool native participant execution.** This is now based on actual
mapped candidate behavior, not preference for our code. Do not adopt unchanged Hermes
planner for the existing18-message contract. Keep its pure planner as the preferred
candidate for a separately specified mention-driven collaborative-room feature;
the explicit adaptation proves compatibility is possible if that feature merits it.

Small current-scheduler retention avoids a Python service/protocol or a792-line port
to replace one selection loop. This is a precise custom-code exception with an exit:
reopen when dynamic mentions/deferred participation becomes a required accepted
outcome, or upstream exposes configurable strict-panel/prompt bounds. Do not treat this
as rejection of Hermes execution, room status, peer grants or workspace reuse.

Latency includes subprocess launch and actual DB/result paths: adapted3member1round
160.8ms;6member3round991.2ms. Different workloads, not an upstream performance ranking.
Peak Node/PGlite memory is recorded in JSON; no daemon/browser/VPS estimate inferred.
First run failed when the6-member fixture used invalid perspective enum names;
one authorized harness repair changed them to `technology`/`finance`, then all cases
passed. No contract was loosened or further failed attempt retried. Both processes
exited and PGlite closed via finally.

Reproduce using `node f4-planner-fetch.mjs <owned-root>`, then
`node --import tsx research/reuse-comparisons/f4-planner-fit.ts <owned-root> <python3.12>`.
Sources pinned and listed in acquisition record. No implementation/production changes,
GitHub writes, credential access or provider calls. Final cleanup documented separately.

## Independent-review corrections and rerun

Review identified recorded-but-not-enforced source identity and unasserted stored
contribution totals. Before any upstream import/adaptation, peer now checks all four
executable Python files against the retained acquisition receipt, requiring exactly
four matching SHA256 values. Stale/modified source fails before execution. Each case
asserts stored contributions equal the full requested total for adapted/one-round
cases and the exact completed first-round prefix for unchanged negative cases.

Reacquired same five files/pin; final twelve-case run exited0 with no contract change.
`f4-planner-recheck-evidence.json` retains full corrected-run mappings/counts. Prior
evidence remains valid within its original scope; no wrong-source execution inferred.
Source checks improve future reproduction, not proof of additional live behavior.
