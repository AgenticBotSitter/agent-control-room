# Start here: public work queue

> **MVP work is open:** the maintainer-wide pause ended on 2026-09-13. Work only from
> a current `CLAIM ACCEPTED` assignment or request an automatic reservation on an issue marked
> `status:ready`. Existing useful branches and evidence remain inputs, but contributors
> must use the new base and paths recorded in the reopening comment. Do not revive a
> closed pull request or obsolete branch unless that comment explicitly says to do so.

Permanent entry point for people and bots. Read the [build/reuse plan](PUBLIC_BUILD_PLAN.md)
and [worker skill](skills/public-build-worker/SKILL.md). Issues are the live status
record; no documentation commit is needed every time a job changes state.

Public `main` is the reconciled implementation baseline through PR #139. It now
includes the configurable-project proof, explicit project pages, safe Project News,
owner-attention prioritization, exact and relative activity times, verified 360px
navigation, restart-style recovery after both successful and failed verification,
and exact-version Codex start/read fences with a noncanonical bounded result reader.
The private Codex host now composes a bridge-recorded activation into one start or
the exact durable thread/turn into one recovery read using only explicit injected
ports. A strict owned fake byte-process adapter supplies both JSONL profiles and
withholds observations unless process retirement is proven. Hermes and Codex terminal
results now share one strict inert evidence shape; the exact-version Codex qualification
and result-publication contract is defined and independently reviewed. A Codex-only
publisher can now verify an externally signed qualification plus the saved plan,
activation and current admission, then persist exact bytes and one pending review
target with restart-safe reservations. The same existing owner-review, verification,
revision and completion services now handle that canonical Codex result, including
safe capacity release and exact replay after restart. These tests use synthetic
signers and injected ports; they do not make a provider or production service live.
Connector, security/configuration and support decisions are published in
[the shared connector contract](docs/SHARED_CONNECTOR_CONTRACT.md),
[the security/configuration contract](docs/SECURITY_CONFIGURATION_CONTRACT.md) and
[the support matrix](docs/SUPPORT_MATRIX.md). New work must use the exact base in its
issue; active contributor branches retain ownership until accepted or handed off.

## Live views

- [Ready](https://github.com/AgenticBotSitter/agent-control-room/issues?q=is%3Aissue+is%3Aopen+label%3Astatus%3Aready)
- [Working](https://github.com/AgenticBotSitter/agent-control-room/issues?q=is%3Aissue+is%3Aopen+label%3Astatus%3Aworking)
- [Needs decision](https://github.com/AgenticBotSitter/agent-control-room/issues?q=is%3Aissue+is%3Aopen+label%3Astatus%3Aneeds-decision)
- [In review](https://github.com/AgenticBotSitter/agent-control-room/issues?q=is%3Aissue+is%3Aopen+label%3Astatus%3Ain-review)
- [Done](https://github.com/AgenticBotSitter/agent-control-room/issues?q=is%3Aissue+is%3Aclosed+label%3Astatus%3Adone)
- [Coordination index](https://github.com/AgenticBotSitter/agent-control-room/issues/12)

Filter further by platform and difficulty labels. Intermediate means specified
implementation/testing; advanced means shared-boundary reasoning or independent
review. No particular vendor/model is required. Every area, including the webpage,
is advertised by responsibility rather than bot name; preserve current PR ownership.

The [complete remaining-work inventory](PUBLIC_BUILD_PLAN.md#complete-remaining-work-and-open-questions)
includes release blockers and later features. The [webpage specification](WEBPAGE_SPEC.md)
defines the actual interface; contributors need no private design files or chat history.

## Current MVP work wave

The issue labels are the live source of truth; this summary tells a new contributor
where the work is concentrated without requiring chat history.

- **Assigned:** #2 Windows portability, #8 Hermes connector, #11 shipped notices,
  #27 Idea Lab/article research, #62 Claude connector, #63 PostgreSQL/recovery and
  #64 distributable service. #65 remains the parent integration outcome for
  persistent result storage.
- **Ready for reservation now:** #125 Mac/Linux worker rehearsal and #128 retained
  restic backups. Each is a substantial,
  self-contained package with owned paths, reuse choices and acceptance checks.
- **Lead integration active:** #10 configurable frontend and #26 canonical shared
  two-harness execution/results. #135 persistent-storage composition is in review.
- **Recently completed:** #115 persistent local artifact storage, #116 truthful
  schedule planning/status, #120 occurrence admission, #121 the security/recovery
  fault matrix, #122 offline authentication/ingress conformance, #126 whole-server
  failure proof and #127 the inert, restart-safe first-owner ceremony.
- **Waiting on named inputs, not forgotten:** #1 final real browser acceptance, the
  automatic-dispatch remainder of #29, the integration/backup remainder of #65, #66
  full server composition, #68 worker installation and #61 final release qualification.

Choose only a `status:ready` issue. Post the exact two-line reservation request in the
worker skill. The serialized GitHub controller rechecks the issue, records the current
`main` revision and changes Ready to Working before its marker says `CLAIM ACCEPTED`.
Begin only when that accepted marker was posted by `github-actions[bot]` and the issue
is Working. A request, `CLAIM PENDING`, label change or failed workflow by itself is
not permission to edit.

## Complete installable-release work board

This is the whole public-core backlog, not a sample of ten jobs. Open the linked issue
for its live status, immutable starting revision, owned paths, dependencies and checks.
Several independent rows can proceed at once after the maintainer-wide pause is lifted.
Existing contributors retain their preserved branches; new contributors reserve a
non-overlapping outcome instead of replacing them.

### Required for the first Hermes-plus-Codex release

| Responsibility | Public job | Finished outcome |
| --- | --- | --- |
| Actual product browser and accessibility | [#1](https://github.com/AgenticBotSitter/agent-control-room/issues/1) | Two isolated projects, real product panels, keyboard/mobile/deep-link and honest lost-request/lost-reply recovery |
| Hermes connector | [#8](https://github.com/AgenticBotSitter/agent-control-room/issues/8) | Real FastMCP continue/status/result mapping with exact identity and honest unsupported/restart behavior |
| Customizable project webpage | [#10](https://github.com/AgenticBotSitter/agent-control-room/issues/10) | Project/task/worker/result/review/files/attention screens using one configurable artifact |
| Shipped notices and attribution | [#11](https://github.com/AgenticBotSitter/agent-control-room/issues/11) | Every shipped dependency and copied/bundled file is bound to its real upstream identity, license and notice |
| Shared Hermes/Codex execution authority | [#26](https://github.com/AgenticBotSitter/agent-control-room/issues/26) | Canonical admission, queue, real starts and verified result claims, review/revision, capacity release and restart recovery; durable bytes/startup composition belong to #65/#66 |
| Persistent-work security and recovery | [#60](https://github.com/AgenticBotSitter/agent-control-room/issues/60) | Before critical effects are enabled, a dedicated approval key and independent rollback record prove restored database and result files still match |
| Final release assembly and qualification | [#61](https://github.com/AgenticBotSitter/agent-control-room/issues/61) | One frozen artifact passes clean install, two real harnesses, browser, recovery, update and restore acceptance |
| PostgreSQL provisioning, migrations and restore | [#63](https://github.com/AgenticBotSitter/agent-control-room/issues/63) | Dedicated least-privilege database, checksum-led upgrades and verified disposable restore |
| Distributable service and safe updates | [#64](https://github.com/AgenticBotSitter/agent-control-room/issues/64) | Self-contained artifact, unprivileged supervised service, staged update and safe rollback/refusal |
| Durable protected result storage | [#65](https://github.com/AgenticBotSitter/agent-control-room/issues/65) | Exact result bytes survive restart/backup and cannot escape project/run authorization or owned storage |
| Persistent local artifact-byte adapter | [#115](https://github.com/AgenticBotSitter/agent-control-room/issues/115) | Production-shaped local byte storage survives restart and refuses conflicts, corruption and path attacks |
| One-time first-owner ceremony | [#127](https://github.com/AgenticBotSitter/agent-control-room/issues/127) | A protected one-use browser ceremony creates exactly one owner without exposing raw identity or persistent local login secrets |
| Independently retained backup set | [#128](https://github.com/AgenticBotSitter/agent-control-room/issues/128) | Pinned restic packages the verified database and artifacts outside the primary and proves an exact restore/checkpoint match |
| Complete agent-task server composition | [#66](https://github.com/AgenticBotSitter/agent-control-room/issues/66) | Operator configuration starts the real database/queue/connectors/results/review lifecycle fail-closed |
| Private ingress and first-owner setup | [#67](https://github.com/AgenticBotSitter/agent-control-room/issues/67) | Supported gateway, no direct-origin bypass, one owner bootstrap and externally enforced MFA |
| Mac/Linux worker setup | [#68](https://github.com/AgenticBotSitter/agent-control-room/issues/68) | Fresh Hermes and Codex worker install, enrollment, version checks, reconnect, revocation and removal |

Accepted foundations no longer shown as open work: [#9](https://github.com/AgenticBotSitter/agent-control-room/issues/9)
was superseded by #64 after its retired-base PR was preserved as implementation input;
[#28](https://github.com/AgenticBotSitter/agent-control-room/issues/28) completed the
portable configuration and login-profile implementation through PRs #34, #36 and #56.
Real two-installation proof remains part of final release qualification in #61.
The bounded mixed-harness source review in
[#21](https://github.com/AgenticBotSitter/agent-control-room/issues/21) was accepted;
each consequential implementation and assembled-release claim still receives its own
proportional independent review before integration.

Lead-integrated PRs #100–#102 completed important portions of #1 and #10: one build
now supports two isolated configurations; project Inbox, Agents, Automations and News
routes are explicit; unknown project routes fail safely; keyboard/mobile browser
coverage and restart-style recovery use disposable data; and owner attention is
categorized and ranked. Those issues remain open because protected file delivery,
live worker/capacity data and final real-harness acceptance depend on #65, #66, #68
and the assembled-release gate in #61.

### Parallel additions and additional platform support

These jobs are real product work, but they do not block the first Linux-server,
Mac/Linux-worker Hermes-plus-Codex release.

| Responsibility | Public job | Finished outcome |
| --- | --- | --- |
| Windows contributor and remote-worker readiness | [#2](https://github.com/AgenticBotSitter/agent-control-room/issues/2) | Reproducible PowerShell setup, portable tests/cleanup and truthful supported/refused worker modes |
| Idea Lab and article-to-research | [#27](https://github.com/AgenticBotSitter/agent-control-room/issues/27) | Real bounded participants, promotion to projects and attributed article tasks returning reviewed results |
| Schedules, pickup and reusable work context | [#29](https://github.com/AgenticBotSitter/agent-control-room/issues/29) | Eligible work continues while review waits; recurring work deduplicates across restart/timezone changes |
| Schedule planning and truthful status | [#116](https://github.com/AgenticBotSitter/agent-control-room/issues/116) | Existing schedule records render next-run and occurrence status without inventing dispatch evidence |
| Extension conformance and optional visibility | [#30](https://github.com/AgenticBotSitter/agent-control-room/issues/30) | Additional adapters use the same authority; optional observation never becomes completion evidence |
| Claude Code connector | [#62](https://github.com/AgenticBotSitter/agent-control-room/issues/62) | Operator-installed bounded JSONL connector returns reviewed text without special authority or a second scheduler |

The first installable release does not require every optional workflow or third harness:
Hermes and Codex form the first two-harness release gate. Claude, Idea Lab/news,
schedules and optional observation can advance in parallel and join only after their
own acceptance. Nothing in this table authorizes credentials, native provider calls or
production changes; those remain separately scoped owner actions.

## Keep the queue current

Each work issue has exactly one status plus platform/difficulty, owner or unassigned
state, dependencies, immutable base/target, owned paths, reuse choice and checks.
Ready means it can begin without guessing a shared contract. Needs decision names
the missing prerequisite and responsible role, not just "blocked."

The automatic claim controller confirms ready reservations using a GitHub-login plus
unique-worker identifier in one short repository-wide serialized workflow. Each exact
pair may hold one active implementation; a request comment, pending marker or shared
GitHub login alone is not an atomic claim. Mark In review when its PR/evidence is submitted, and
Done/closed after the whole assigned outcome is accepted. Partial merges are not
completion. Transfer ownership only after an explicit stop/handoff, not a timer.

Workers update milestones, blockers and submissions in the issue; no unchanged timer
spam. They may continue other confirmed independent work while review is pending.
Automated workers obtain one risk-proportionate independent subagent check against the
exact local commit before submission and include its concise verdict in the handoff.
That check supports, but never replaces, the lead's final review and merge decision.
At integration, maintainers update status and identify the next ready assignments.
Plan changes update affected rows/issues with one concise reason. The owner should
not have to forward files or act as courier. Historical evidence remains intact.

## Standing instruction for an existing worker session

> Read this queue and the public worker skill. If the maintainer-wide pause is active,
> stop without editing or pushing. Otherwise choose ready work matching your actual
> platform/capability. Follow a confirmed assignment or request the automatic reservation before
> editing. Report progress, blockers and PRs in its issue, then continue the next
> confirmed independent assignment. Preserve other checkouts and dependency gates;
> do not self-merge or infer native-effect authority. If nothing is eligible, report
> that once rather than making up work or repeatedly polling.

GitHub does not wake idle bots. Their existing sessions or separately configured
schedulers must read this page. No scheduler, webhook or polling Actions workflow is
installed here. Public CI remains enabled for verification, not job dispatch.
