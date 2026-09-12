# Contributing to Agent Control Room

This guide covers contributions to the pre-alpha source preview under Apache-2.0.
Alastair Fraser is the maintaining owner. Work in your own checkout with disposable
data; contributing does not grant access to a maintainer's machines or agents.

General project questions: [Alastair@agenticbotsitter.com](mailto:Alastair@agenticbotsitter.com).
Do not send credentials or private installation records. If the repository offers
private vulnerability reporting, use its Security tab. Until that route is enabled,
email the project contact to arrange private reporting without including exploit
details or sensitive data in the initial message. Never use a public issue for secrets.

## What we are building

Agent Control Room is a shared workspace for projects, tasks, agent workers, schedules,
approvals and results. Each project has its own page. The core coordinates work across
different agent runtimes; optional workflows add ideas, research, news and content tools.
We prefer proven libraries and thin integrations over new custom infrastructure.

A passing test is useful evidence, not proof of a live deployment. The developer preview
uses clearly labeled synthetic work; production and native-runtime readiness are
tracked separately. Do not claim a real agent worked just because a fixture completed.

## Choose work you can complete

Start with the current [public-first plan and role-based openings](PUBLIC_BUILD_PLAN.md).
All focus areas welcome humans and bots; active PRs retain their ownership. Use the
[public worker skill](skills/public-build-worker/SKILL.md) for ordinary assignments
and the [review skill](skills/public-build-review/SKILL.md) for proportionate review.
These public assignments do not require a private V2 controller or result manifest.
The plan explains the current main/component-branch distinction; each assignment
must pin its actual starting SHA and target before implementation begins.

Read [setup](SETUP.md), [work packages](WORK_PACKAGES.md) and the [roadmap](ROADMAP.md).
The candidate includes check/build/tests and the explicit `pnpm demo` command.
One local macOS desktop browser trial passed; wider platform/accessibility acceptance
and live operation remain unfinished. This is not a production release.

Start with an issue marked ready and read its acceptance criteria before claiming it.
Every ready issue should identify:

- The outcome and exact public base revision.
- Platform/runtime requirements, such as `[Any OS][UI]` or `[Windows][Validation]`.
- Dependencies, allowed files and work that is explicitly outside scope.
- Preparation and verification commands, including any separately authorized downloads.
- The reviewing maintainer and required handoff evidence.

Missing prerequisites are a reason to clarify the issue, not to experiment with another
person's credentials or machine. A platform label is a work requirement, not proof that
the entire application supports that platform.

Ask for assignment in the issue before starting. Maintainers confirm one responsible
contributor to avoid duplicate work. Do not assume a comment alone is an atomic claim.
If you propose unlisted work, explain the user benefit and discuss overlapping changes
before investing in a large patch.

## Make the change

Use your own fork/checkout and a dedicated branch based on the specified revision.
Keep one independently reviewable outcome per PR. Preserve unrelated changes and do not
share a live checkout, credentials, local databases or dependency directories with other
contributors or agents.

Follow the published setup guide with the pinned package manager and frozen lockfile.
Keep dependency preparation separate from tests and live platform validation. Do not
upgrade packages, install tools or add network fallback merely to get a green test.
Record a missing prerequisite and ask for the appropriate setup decision.

Fix ordinary implementation mistakes within the agreed scope and rerun relevant tests.
A failed test is not a permanent disqualification. A native/provider attempt, however,
must follow its explicit limits; never retry an uncertain external action as if it were
an ordinary unit test. Stop before expanding permissions, data scope or cleanup targets.

When adopting code, name its upstream repository and exact revision/version, preserve
its notices, and explain what changed. Discuss dependencies and licensing before adding
them. AI-assisted contributions have the same requirements as human-written changes;
the contributor remains responsible for understanding and checking the result.

## Submit useful evidence

Run checks locally and batch meaningful pushes and review requests. Public CI is
enabled for pull requests and main using free standard GitHub-hosted runners.
External contributors' runs require maintainer approval; tokens are read-only and
cannot approve PRs. The repository allows only the reviewed pinned external actions.
Do not add workflows, scheduled jobs, automatic deployments or self-hosted public-PR
runners without explicit maintainer approval. Do not use skip-ci on code changes.
Private-repository minute quotas do not apply to these public standard-runner jobs;
storage/cache and larger runners have separate limits and billing.

Use this short PR summary:

```text
Issue and outcome:
Base revision / submitted revision:
Files changed and why:
Platform and tool versions:
Commands run and actual results:
What was not tested:
Upstream code/dependencies and attribution:
Known limitations or follow-up:
```

For UI changes, include synthetic screenshots and keyboard/narrow-screen checks where
relevant. Never include private project records, credential values, host identities or
raw native diagnostics. Reports should distinguish observed behavior from assumptions.
If a check fails, show a sanitized reproduction rather than relabeling it as a pass.

## Keep moving while reviews happen

You may take another assigned, independent issue while a PR awaits review. You can have
several independent PRs open; you do not need to wait after every completed task.
Do not stack unrelated work on an unmerged branch. If a change genuinely depends on
another PR, state that dependency and its exact base; maintainers integrate in order.

If blocked, leave a draft PR or a concise issue update with the current revision,
reproduction, completed work and precise missing decision. Ask the maintainer to release
your assignment if you cannot continue. Preserve useful evidence; never erase a failed
attempt or rewrite another contributor's branch to make the handoff look complete.

## How review works

Maintainers compare scope, implementation and test evidence, then request focused fixes
or accept the change. Contributors do not approve or merge their own PRs. Automated
checks and assistant reviews support an accountable maintainer; multiple agent messages
are not multiple independent GitHub approvals.

Architecture, permissions, secret handling, database migrations and live execution stay
maintainer-led. These areas need explicit scope and risk-appropriate independent review,
not an ordinary UI issue that quietly grows into an authority change. Small UI/docs
changes should receive proportionate review rather than a production release ceremony.

Merge and deployment are separate decisions. Untrusted PRs must not run with maintainer
credentials or on private agent hosts. Contributor tests use disposable resources.
Report vulnerabilities through the project's designated private reporting route once
published; never post exploits containing private data or credentials in normal issues.

## License and contribution terms

Original project code uses [Apache-2.0](LICENSE); third-party notices remain applicable.
Submit only work you have the right to contribute. Contributions intentionally submitted
for inclusion follow the project's license terms. This preview does not add a separate
CLA or DCO sign-off requirement. Discuss license exceptions before submitting code.

Ready assignments name their reviewing maintainer. Assistant reviews support that
maintainer; they do not create additional human maintainers or merge permissions.
