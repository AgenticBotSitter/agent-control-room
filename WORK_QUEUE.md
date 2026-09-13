# Start here: public work queue

Permanent entry point for people and bots. Read the [build/reuse plan](PUBLIC_BUILD_PLAN.md)
and [worker skill](skills/public-build-worker/SKILL.md). Issues are the live status
record; no documentation commit is needed every time a job changes state.

Public `main` is the reconciled implementation baseline through PR #42 at
`bcb93b8dfb6ddca5511f70116bd095a4610209d2`. Connector, security/configuration and
support decisions are published in [the shared connector contract](docs/SHARED_CONNECTOR_CONTRACT.md),
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

## Complete installable-release work board

This is the whole public-core backlog, not a sample of ten jobs. Open the linked issue
for its live status, immutable starting revision, owned paths, dependencies and checks.
Several independent rows can proceed at once. Existing contributors keep their active
branches; new contributors reserve a non-overlapping outcome instead of replacing them.

### Required for the first Hermes-plus-Codex release

| Responsibility | Public job | Finished outcome |
| --- | --- | --- |
| Actual product browser and accessibility | [#1](https://github.com/AgenticBotSitter/agent-control-room/issues/1) | Two isolated projects, real product panels, keyboard/mobile/deep-link and honest lost-request/lost-reply recovery |
| Hermes connector | [#8](https://github.com/AgenticBotSitter/agent-control-room/issues/8) | Real FastMCP continue/status/result mapping with exact identity and honest unsupported/restart behavior |
| Existing release-package contribution | [#9](https://github.com/AgenticBotSitter/agent-control-room/issues/9) | Correct and integrate reusable PR #13 scaffolding into #64; new database/storage/ingress work belongs to #63/#65/#67 |
| Customizable project webpage | [#10](https://github.com/AgenticBotSitter/agent-control-room/issues/10) | Project/task/worker/result/review/files/attention screens using one configurable artifact |
| Shipped notices and attribution | [#11](https://github.com/AgenticBotSitter/agent-control-room/issues/11) | Every shipped dependency and copied/bundled file is bound to its real upstream identity, license and notice |
| Independent consequential review | [#21](https://github.com/AgenticBotSitter/agent-control-room/issues/21) | Security, recovery and assembled-release claims receive independent material review |
| Shared Hermes/Codex execution authority | [#26](https://github.com/AgenticBotSitter/agent-control-room/issues/26) | Canonical admission, queue, real starts and verified result claims, review/revision, capacity release and restart recovery; durable bytes/startup composition belong to #65/#66 |
| Portable product and login methods | [#28](https://github.com/AgenticBotSitter/agent-control-room/issues/28) | Same artifact serves separate configurations through a supported, verified login gateway |
| Persistent-work security and recovery | [#60](https://github.com/AgenticBotSitter/agent-control-room/issues/60) | A dedicated approval key and independent rollback record prove restored database and result files still match |
| Final release assembly and qualification | [#61](https://github.com/AgenticBotSitter/agent-control-room/issues/61) | One frozen artifact passes clean install, two real harnesses, browser, recovery, update and restore acceptance |
| PostgreSQL provisioning, migrations and restore | [#63](https://github.com/AgenticBotSitter/agent-control-room/issues/63) | Dedicated least-privilege database, checksum-led upgrades and verified disposable restore |
| Distributable service and safe updates | [#64](https://github.com/AgenticBotSitter/agent-control-room/issues/64) | Self-contained artifact, unprivileged supervised service, staged update and safe rollback/refusal |
| Durable protected result storage | [#65](https://github.com/AgenticBotSitter/agent-control-room/issues/65) | Exact result bytes survive restart/backup and cannot escape project/run authorization or owned storage |
| Complete agent-task server composition | [#66](https://github.com/AgenticBotSitter/agent-control-room/issues/66) | Operator configuration starts the real database/queue/connectors/results/review lifecycle fail-closed |
| Private ingress and first-owner setup | [#67](https://github.com/AgenticBotSitter/agent-control-room/issues/67) | Supported gateway, no direct-origin bypass, one owner bootstrap and externally enforced MFA |
| Mac/Linux worker setup | [#68](https://github.com/AgenticBotSitter/agent-control-room/issues/68) | Fresh Hermes and Codex worker install, enrollment, version checks, reconnect, revocation and removal |

### Parallel additions and additional platform support

These jobs are real product work, but they do not block the first Linux-server,
Mac/Linux-worker Hermes-plus-Codex release.

| Responsibility | Public job | Finished outcome |
| --- | --- | --- |
| Windows contributor and remote-worker readiness | [#2](https://github.com/AgenticBotSitter/agent-control-room/issues/2) | Reproducible PowerShell setup, portable tests/cleanup and truthful supported/refused worker modes |
| Idea Lab and article-to-research | [#27](https://github.com/AgenticBotSitter/agent-control-room/issues/27) | Real bounded participants, promotion to projects and attributed article tasks returning reviewed results |
| Schedules, pickup and reusable work context | [#29](https://github.com/AgenticBotSitter/agent-control-room/issues/29) | Eligible work continues while review waits; recurring work deduplicates across restart/timezone changes |
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

Maintainers confirm reservations using a unique worker/contributor identifier. A
comment or shared GitHub login alone is not an atomic claim. Mark Working only when
the contributor confirms starting, In review when its PR/evidence is submitted, and
Done/closed after the whole assigned outcome is accepted. Partial merges are not
completion. Transfer ownership only after an explicit stop/handoff, not a timer.

Workers update milestones, blockers and submissions in the issue; no unchanged timer
spam. They may continue other confirmed independent work while review is pending.
At integration, maintainers update status and identify the next ready assignments.
Plan changes update affected rows/issues with one concise reason. The owner should
not have to forward files or act as courier. Historical evidence remains intact.

## Standing instruction for an existing worker session

> Read this queue and the public worker skill. Choose ready work matching your actual
> platform/capability. Follow a confirmed assignment or request reservation before
> editing. Report progress, blockers and PRs in its issue, then continue the next
> confirmed independent assignment. Preserve other checkouts and dependency gates;
> do not self-merge or infer native-effect authority. If nothing is eligible, report
> that once rather than making up work or repeatedly polling.

GitHub does not wake idle bots. Their existing sessions or separately configured
schedulers must read this page. No scheduler, webhook or polling Actions workflow is
installed here. Public CI remains enabled for verification, not job dispatch.
