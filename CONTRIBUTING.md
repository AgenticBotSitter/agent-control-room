# Contributing to Agent Control Room

Start with the [Contributor Handbook](CONTRIBUTOR_HANDBOOK.md), the sole authoritative
contribution lifecycle. It covers choosing and claiming work, isolated checkouts,
implementation, evidence, review, corrections, ownership, and integration. This file
contains project background and additional project policies.

This guide covers contributions to the pre-alpha source preview under Apache-2.0.
Alastair Fraser is the maintaining owner. Contributing does not grant access to a
maintainer's machines or agents.

General project questions: [Alastair@agenticbotsitter.com](mailto:Alastair@agenticbotsitter.com).
For private security reporting, follow the handbook's
[security guidance](CONTRIBUTOR_HANDBOOK.md#security-licensing-and-public-evidence).

## What we are building

Agent Control Room is a shared workspace for projects, tasks, agent workers, schedules,
approvals and results. Each project has its own page. The core coordinates work across
different agent runtimes; optional workflows add ideas, research, news and content tools.
We prefer proven libraries and thin integrations over new custom infrastructure.

The developer preview uses clearly labeled synthetic work. Production and native-runtime
readiness are tracked separately; this is not a production release. A platform label on
an assignment describes its requirements, not support for the entire application.

See the [public build plan](PUBLIC_BUILD_PLAN.md), [setup](SETUP.md),
[work packages](WORK_PACKAGES.md), and [roadmap](ROADMAP.md). The plan records reuse
decisions and the current main/component-branch distinction. Reuse evidence should name
the decision IDs, donor and revision, existing evidence, remaining fit test, and final
attribution. Follow the handbook's [assignment requirements](CONTRIBUTOR_HANDBOOK.md#read-the-assignment-before-claiming)
and [implementation guidance](CONTRIBUTOR_HANDBOOK.md#build-the-complete-outcome).

The [public worker skill](skills/public-build-worker/SKILL.md) and
[review skill](skills/public-build-review/SKILL.md) are role-specific entry points to the
handbook. Public assignments do not require a private V2 controller or result manifest.
For unlisted work, explain its user benefit and discuss overlap before investing in a
large patch.

## Dependencies and CI policy

Discuss new dependencies and licensing before adding them. Do not upgrade packages,
install tools, or add network fallback merely to get a green test. Report missing setup
prerequisites so they can receive the appropriate decision. AI-assisted contributions
have the same requirements as human-written work; contributors remain responsible for
understanding and checking the result.

Public CI runs on pull requests and main using standard GitHub-hosted runners. External
contributors' runs require maintainer approval; tokens are read-only and cannot approve
PRs. Only reviewed, pinned external actions are allowed. Do not add workflows, scheduled
jobs, automatic deployments, or self-hosted public-PR runners without explicit maintainer
approval. Do not use skip-ci on code changes. Public standard-runner jobs do not consume
private-repository minute quotas; storage/cache and larger runners have separate limits
and billing.

For required checks, submission evidence, reviewer independence, and protected changes,
follow the handbook's [verification](CONTRIBUTOR_HANDBOOK.md#check-the-work-proportionately),
[submission](CONTRIBUTOR_HANDBOOK.md#commit-and-submit), and
[review](CONTRIBUTOR_HANDBOOK.md#review-and-corrections) sections.

## License and contribution terms

Original project code uses [Apache-2.0](LICENSE); third-party notices remain applicable.
Submit only work you have the right to contribute. Contributions intentionally submitted
for inclusion follow the project's license terms. This preview does not add a separate
CLA or DCO sign-off requirement. Discuss license exceptions before submitting code.

Assistant reviews support the accountable maintainer; they do not create additional
human maintainers or merge permissions. See the handbook for
[shared-account authority](CONTRIBUTOR_HANDBOOK.md#shared-accounts-and-trusted-transitions)
and [integration requirements](CONTRIBUTOR_HANDBOOK.md#lead-integration-and-completion).
