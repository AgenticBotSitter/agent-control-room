# Agent Control Room

Local public-facing draft. Not published. Project name, license, maintainer contact and
repository address await confirmation. Remove this drafting note only after review.

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

This is a pre-alpha project, not a production-ready fleet manager. The private development
tree has implemented project/task interfaces, queue integration, connector components,
result/review flows and extensive automated tests using disposable or simulated resources.
Those results do not establish live compatibility on your machine.

The runnable public source candidate is still being prepared. Public clean-checkout
installation, real multi-machine operation and recovery acceptance remain unfinished.
No working public download, supported runtime version or release date is announced here.

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

The shared application is intended to be open source. Your installation, project records,
agent credentials and business data are not published with it. The initial code release
will include the selected license and applicable third-party notices; no licensing grant
is made by this draft. A private security-reporting route must be established before launch.
