# Agent Control Room

Pre-alpha contributor source preview. Try the disposable local demo and help finish
the live project-to-agent workflow. This is not a production-ready installation.

Project website: [agentcontrolroom.xyz](https://agentcontrolroom.xyz).

Repository: [AgenticBotSitter/agent-control-room](https://github.com/AgenticBotSitter/agent-control-room).

Maintainer: Alastair Fraser. Main website: [agenticbotsitter.com](https://agenticbotsitter.com).

Project contact: [Alastair@agenticbotsitter.com](mailto:Alastair@agenticbotsitter.com).

## Join the build — start here

Everything needed to contribute is public. No invitation, private repository, paid
agent subscription or access to our machines is needed. Humans and bots are welcome.
This README is the front door; detailed documents are optional depth, not a hunt.

**Current priority:** finish a real mixed-harness project → task → result → review
workflow, using existing proven components. One configurable public product serves
everyone; no separate private core.

| What you want to know | Direct link / answer |
| --- | --- |
| What can I take on now? | [Ready assignments](https://github.com/AgenticBotSitter/agent-control-room/issues?q=is%3Aissue+is%3Aopen+label%3Astatus%3Aready) — filter platform/difficulty, request a reservation |
| What is being worked or reviewed? | [Working](https://github.com/AgenticBotSitter/agent-control-room/issues?q=is%3Aissue+is%3Aopen+label%3Astatus%3Aworking) · [In review](https://github.com/AgenticBotSitter/agent-control-room/issues?q=is%3Aissue+is%3Aopen+label%3Astatus%3Ain-review) · [Open PRs](https://github.com/AgenticBotSitter/agent-control-room/pulls) |
| What is blocked, and who decides? | [Needs decision](https://github.com/AgenticBotSitter/agent-control-room/issues?q=is%3Aissue+is%3Aopen+label%3Astatus%3Aneeds-decision) — each names the missing input |
| What has been accepted? | [Completed outcomes](https://github.com/AgenticBotSitter/agent-control-room/issues?q=is%3Aissue+is%3Aclosed+label%3Astatus%3Adone) · [Merged contributions](https://github.com/AgenticBotSitter/agent-control-room/pulls?q=is%3Apr+is%3Amerged) — partial PRs do not imply a whole feature is finished |
| What is the full plan and what are we borrowing? | [All outcomes, reuse decisions and next steps](PUBLIC_BUILD_PLAN.md) · [Attribution](THIRD_PARTY.md) |
| Exactly what remains, including unanswered questions? | [Complete remaining-work inventory](PUBLIC_BUILD_PLAN.md#complete-remaining-work-and-open-questions) — substantial workstreams, dependencies, decisions and release gates |
| What should the webpage look like and do? | [Public webpage specification](WEBPAGE_SPEC.md) — layout, every core screen, optional modules, error states and acceptance |
| Where do I ask or propose a different useful contribution? | [Coordination issue #12](https://github.com/AgenticBotSitter/agent-control-room/issues/12) — describe your expertise and a substantial non-overlapping outcome |

**Already available:** disposable project/task/revision demo, substantial source and
component tests, public CI, Linux rehearsal/browser-tooling contributions and retained
upstream notices. **Still to finish:** real Hermes/Codex integration and recovery,
customizable product webpage, release/install/rollback, portable notices, platform
acceptance and a verified multi-worker release. Optional Idea Lab/news/extensions
follow the core loop. No live harness compatibility is claimed by the demo.

### Contribute in five steps

1. Pick a ready issue fitting your platform and skills. Comment with the slice you
   want; the maintainer confirms ownership to prevent duplicate work. No special bot
   name is required. Small non-overlapping typo fixes can be proposed directly.
2. Fork this repository using GitHub's **Fork** button, then clone **your fork**:

   ```sh
   git clone https://github.com/YOUR-USERNAME/agent-control-room.git
   cd agent-control-room
   git remote add upstream https://github.com/AgenticBotSitter/agent-control-room.git
   git fetch upstream
   git switch -c contribution/my-feature ISSUE_BASE_SHA
   ```

   Replace ISSUE_BASE_SHA with the confirmed issue revision. Public `main` is the
   reconciled implementation baseline. Every assignment still names its immutable
   starting commit and owned paths; do not guess or duplicate an active contribution.
3. Use Node >=22.13 and pnpm 11.19.0. Prepare with
   `pnpm install --frozen-lockfile --ignore-scripts` (downloads dependencies), then
   `pnpm check:demo` and the issue's targeted checks. For the optional disposable
   webpage try `pnpm demo`; never include its login code in screenshots or logs.
   [Setup details, including PowerShell and pnpm installation](SETUP.md).
4. Build the whole assigned outcome, reuse the selected upstream component and retain
   notices. Fix ordinary test failures normally. Commit only intended files:
   `git add PATHS`, `git commit -m "Describe the outcome"`, then
   `git push -u origin contribution/my-feature`. Never commit credentials or local data.
5. Open **Compare & pull request** on GitHub against the issue's target branch. State
   outcome, base/head, checks/results, limitations and borrowed sources. Maintainers
   review/merge; public CI checks the contribution. Continue other reserved independent
   work while review is pending. [Full contribution guide](CONTRIBUTING.md).

No eligible work in the ready view? Offer a concrete capability in #12; maintainers
must supply a safe independent slice or identify the decision blocking it, rather
than tell contributors the whole project is finished. Our [worker instructions](skills/public-build-worker/SKILL.md)
and [review instructions](skills/public-build-review/SKILL.md) are optional reusable
guides; there is no private controller or mandatory result-manifest ceremony.

## Help finish the public release

**[Start here: live work queue](WORK_QUEUE.md)** — ready work, progress, decisions
needed and accepted outcomes for human and bot contributors.

Humans and bots are welcome. See the [public build plan and focus areas](PUBLIC_BUILD_PLAN.md)
and [coordination issue #12](https://github.com/AgenticBotSitter/agent-control-room/issues/12).
Choose work by your expertise and platform; maintainers confirm non-overlapping
assignments. We are building one configurable product, not separate public/private
versions. Large useful contributions, normal debugging and concise reviews are the default.

## One place for projects and the agents working on them

Agent Control Room is being built as a self-hosted workspace for coordinating AI agents
across projects and machines. Give each project its own page, assign work to suitable
agents, follow progress, collect results and decide what happens next.

The goal is useful collaboration without manually relaying every message between
agents. You remain in control of permissions, budgets and consequential actions.

## What we want you to be able to do

- Open a project, see its tasks, files, progress and decisions, then archive it when done.
- Let compatible workers pick up eligible work and continue while completed work awaits review.
- Use different agent runtimes on different machines without sharing their credentials.
- Ask several agents to explore an idea, compare their answers and turn the result into a project.
- Turn an interesting article into a research task or setup guide and keep the result with its project.
- See what needs your attention without watching every worker continuously.
- Reconnect after interruptions and update the system without silently repeating uncertain work.

## Honest status

This is a pre-alpha project, not a production-ready fleet manager. The source includes
project/task interfaces, queue integration, connector components,
result/review flows and extensive automated tests using disposable or simulated resources.
Those results do not establish live compatibility on your machine.

This source preview includes an explicit `pnpm demo` command for a local,
disposable project/task/sample/revision experience. It passes strict type checking,
30 demo tests and two compiled-demo tests on macOS. One owner-approved local browser
trial also completed login, project/task creation, sample revision, refresh recovery,
separate project tabs and archiving, followed by verified shutdown/data cleanup.
That is synthetic demo evidence, not live-agent or multi-machine acceptance.
No live agent-runtime/platform combination is claimed supported by this preview.

## Contributor starting points

**Current implementation baseline:** public `main`, reconciled and verified through
[PR #33](https://github.com/AgenticBotSitter/agent-control-room/pull/33) at
`6bd86541b57dd7fe5d2370ed542f0b3869f41eee`. The
[September 9 contributor handoff](CONTRIBUTOR_HANDOFF.md) remains historical evidence;
new contributions use the base recorded in their issue. This is not production
acceptance and does not supersede active contributors' branches.

**New: [settled component decisions](COMPONENT_DECISIONS.md) and
[implementation packages](IMPLEMENTATION_PACKAGES.md).** These identify what to
reuse, what not to rebuild, and which packages still need focused test exports
before assignment. All 17 implementation directions are recorded; selected
components are not yet all integrated.

The September 8 source refresh adds sanitized Idea Lab and news workflows,
connector updates and generic database/operator templates. The public package
passes `pnpm check`, `pnpm build` and all 56 compiled tests in `pnpm test`.
Templates are not configured services, and these checks are not production acceptance.

- [Setup and verified check commands](SETUP.md)
- [How to contribute and get work assigned](CONTRIBUTING.md)
- [Substantial MVP-first work packages](WORK_PACKAGES.md)
- [Full roadmap and completion criteria](ROADMAP.md)
- [Architecture and trust boundaries](docs/ARCHITECTURE.md)
- [Shared connector and result contract](docs/SHARED_CONNECTOR_CONTRACT.md)
- [Security, portable configuration and recovery contract](docs/SECURITY_CONFIGURATION_CONTRACT.md)
- [Honest platform and connector support matrix](docs/SUPPORT_MATRIX.md)

Hermes and Codex are the first integration priorities. Claude Code, OpenClaw and other
harnesses are proposed contributor tracks, not current compatibility claims. Start with
the minimum usable project-to-task-to-result-to-revision experience before expansion.

Run ordinary checks locally and use the public CI checks on pull requests and main.
Standard GitHub-hosted runners are free for this public repository. External
contributors' runs require maintainer approval. Batch meaningful pushes and reviews;
do not add scheduled builds, automatic deployment or privileged runners.

## How the pieces fit

The browser talks to one application. PostgreSQL stores authoritative project and job
state. Registered node connectors communicate with the application over authenticated
HTTPS and adapt approved work to supported agent runtimes. Files and review decisions
return to the originating project. Local worker limits still apply.

We prefer maintained components over new infrastructure. The queue uses pg-boss;
Hermes integrations prefer supported native interfaces. MCP tools, where provided,
use the same application services rather than introducing a second scheduler.
PGlite is for development/tests, not the production database.

## What help will be useful

We plan to open work on project/task usability, accessible interfaces, reproducible
setup, runtime adapters, news/research workflows, Idea Lab and reliability testing.
Each ready issue will state its outcome, prerequisites, dependencies and completion tests.

Contributors will use ordinary GitHub issues and pull requests. You will not need access
to the maintainers' machines or private project data. Independent changes can be reviewed
in parallel; unfinished or blocked work can be handed back with a reproducible explanation.

Architecture, permission boundaries and integration changes require maintainer review.
Agent-assisted contributions are welcome, but the submitter remains responsible for
understanding the change, testing it and respecting upstream licenses.

## Roadmap

1. Publish a reviewed, generic contributor demo with clear installation and test instructions.
2. Prove one complete live task: assignment, execution, returned files, review and revision.
3. Expand supported machines and runtimes, automatic pickup and recovery.
4. Complete bounded multi-agent idea discussions and news-to-project workflows.
5. Validate backup, restore, updates and sustained everyday operation before a beta claim.

## Privacy and licensing

Original Agent Control Room code in this candidate is licensed under the
[Apache License, Version 2.0](LICENSE). See [project attribution](NOTICE).
Third-party code and dependencies retain their own licenses and notices; the project
license does not relicense them. See [third-party distribution scope](THIRD_PARTY.md).
Your installation, project records, agent credentials and business data are not
published with the application. Do not put vulnerabilities, credentials or private
installation details in public issues. The contributor guide explains private contact.
