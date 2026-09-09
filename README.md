# Agent Control Room

Pre-alpha contributor source preview. Try the disposable local demo and help finish
the live project-to-agent workflow. This is not a production-ready installation.

Project website: [agentcontrolroom.xyz](https://agentcontrolroom.xyz).

Repository: [AgenticBotSitter/agent-control-room](https://github.com/AgenticBotSitter/agent-control-room).

Maintainer: Alastair Fraser. Main website: [agenticbotsitter.com](https://agenticbotsitter.com).

Project contact: [Alastair@agenticbotsitter.com](mailto:Alastair@agenticbotsitter.com).

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

**Latest implementation handoff:** [September 9 contributor handoff](CONTRIBUTOR_HANDOFF.md).
The six-batch implementation is on `codex/component-batch-4` for review, not yet
accepted into main. Use that branch for the latest code; do not duplicate completed
components from older roadmap descriptions. No complete batch or production
installation is claimed finished.

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

Hermes and Codex are the first integration priorities. Claude Code, OpenClaw and other
harnesses are proposed contributor tracks, not current compatibility claims. Start with
the minimum usable project-to-task-to-result-to-revision experience before expansion.

Run ordinary checks locally. GitHub Actions remains disabled; batch meaningful pushes
and reviews. Small local commits are welcome. Do not add scheduled builds, automatic
deployment or privileged runners for public contributions.

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
