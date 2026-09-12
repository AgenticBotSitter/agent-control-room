# Start here: public work queue

Permanent entry point for people and bots. Read the [build/reuse plan](PUBLIC_BUILD_PLAN.md)
and [worker skill](skills/public-build-worker/SKILL.md). Issues are the live status
record; no documentation commit is needed every time a job changes state.

Public `main` is the reconciled implementation baseline through PR #32 at
`aebbbf165bdabcc4da6e6fd08e7e247fd66e9ae6`. Connector, security/configuration and
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
