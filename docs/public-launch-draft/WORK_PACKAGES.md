# Contributor work packages

These are substantial contribution outcomes, not automatic assignments or claims.
Check the repository's ready issues for work currently available. A maintainer must add the exact public
base commit, allowed files, reviewing maintainer and runnable acceptance commands before
marking a package ready. Never point contributors at the private development checkout.

## MVP first

The minimum viable product is one private installation where an owner can create a
project, assign useful work, watch progress, read a returned file, request a revision
and review the revised result. Other eligible work can continue during review. Each
project has its own page and history. The first supported harnesses are Hermes and
Codex; real support requires tested versions and platforms, not merely adapter code.

| Package / proposed issue title | Substantial deliverable | Acceptance outcome | Dependency |
|---|---|---|---|
| [Any OS][MVP] Complete the project/task/result user journey | Integrate existing project, task, result, revision and review screens; cover loading, denied, empty and uncertain states, keyboard access and separate project tabs | Fresh demo project reaches a visibly simulated result and revision; refresh loses neither records nor pending-save identity; no native run is implied | Reviewed runnable source and demo setup |
| [macOS/Windows/Linux][MVP] Reproducible contributor installation | Validate documented prerequisites, pinned dependency preparation, migrations, build, demo startup, shutdown and cleanup on the claimed OS | A contributor without maintainer access reproduces the documented journey from a clean checkout; report each tested OS/version separately | Reviewed source candidate; authorized dependency downloads |
| [Linux][MVP] Package the private controller installation | Assemble existing startup entries and operator instructions for PostgreSQL, process supervision, configuration checks and rollback | Disposable installation starts with no public database; missing configuration is actionable; stop/restart and rollback are documented and tested | Maintainer-approved deployment/configuration contracts; no production changes in this package |
| [Hermes][MVP] Complete connector packaging and lifecycle tests | Reuse supported upstream Hermes interfaces and existing adapter; package configuration, compatibility checks, progress, results, cancellation and reconnect | One separately authorized real task and revision return to the correct project; lost response never triggers an unapproved second run | Stable public connector contract; exact OS/Hermes version; separately approved native calls |
| [Codex][MVP] Complete connector packaging and lifecycle tests | Reuse the supported upstream Codex interface and existing adapter; supply equivalent setup, capability and lifecycle evidence | Same task/result/revision and interruption scenarios as Hermes, with exact tested versions | Stable public connector contract; exact OS/Codex version; separately approved native calls |
| [Any OS][MVP] Continuous pickup and actionable attention | Integrate existing queue/capacity rules with worker status and owner attention views; cover blocked work and handback | Multiple independent jobs progress while earlier work awaits review; unsupported jobs are declined before starting; uncertain work is visible | Stable task/connector contracts and reproducible fake-worker setup |
| [Any OS][MVP] Recovery and update acceptance | Exercise existing drain/reconnect/update/restore paths, compatibility failures and operator recovery instructions | Saved results survive supported restarts; a failed update has a tested rollback; no claimed exactly-once external effects | Packaged controller and fake-worker setup; live trials separately authorized |

## First contribution batches after publication

The simulated task/result/revision flow and session-history read now exist. Do not
rebuild those services. The first two packages below become assignable after the
maintainer inserts the first reviewed public commit and names a reviewer in the
issue. They can proceed independently. Neither needs a real agent or our machines.

### DEMO-UX — Complete and verify the browser journey

**Title:** [Any OS][MVP][No live agents] Browser journey, recovery and accessibility

- Outcome: a contributor can create two projects in separate tabs, propose a task,
  generate a sample, inspect it, request a revision, refresh and continue without
  losing the revision chain. Finish interaction defects, not a new design system.
- Allowed implementation: `contributor-demo/`,
  `app/components/contributor-simulation.tsx`, `app/local-preview/workspace.tsx`,
  existing shared styles, and focused demo/browser tests. Propose changes outside
  this scope before editing them. Authentication and server authority rules stay
  unchanged.
- Verify keyboard-only operation, meaningful labels/focus, narrow-screen layout,
  loading and access-denied states, two distinct project tabs and escaped sample
  text. Test a POST lost before delivery separately from a response lost after
  acceptance; neither should silently erase feedback or automatically repeat work.
- Reuse a maintained browser-test tool if needed; explain any new dependency,
  upstream license and why installed tooling is insufficient. Do not introduce a
  custom browser automation framework.
- Local checks: `pnpm check:demo`, `pnpm test:demo`,
  `pnpm test:build:demo`. Until this package delivers a browser automation command,
  start `pnpm demo` and manually check login, project/task creation, sample generation,
  feedback/revision, refresh/history, isolation between two projects, archive and
  normal shutdown/temporary-data cleanup. Include keyboard and narrow-screen checks.
  Deliver and document a repeatable browser acceptance command as part of this package;
  do not claim that command already exists in the base release.
- Handoff: one cohesive PR with implementation, repeatable interaction tests and a
  short evidence table. Redact login codes; screenshots alone do not prove the flow.

### SETUP-OS — Reproduce installation and cleanup on another OS

**Title:** [Choose macOS, Windows or Linux][MVP][No live agents] Contributor setup

- Claim one named OS first. Multiple contributors can take distinct OS assignments
  without modifying the same scripts concurrently.
- Outcome: a clean checkout installs pinned dependencies without maintainer files,
  builds both profiles, runs checks and demonstrates the disposable browser flow.
  Clearly separate dependency downloads from runtime operations.
- Allowed implementation: `SETUP.md`, focused platform smoke tests and fixes to
  `scripts/contributor-demo.mjs` or `src/contributor-demo/launcher.ts`. A dependency,
  schema or protocol change requires maintainer review before implementation.
- Run `pnpm check`, `pnpm check:demo`, `pnpm test`,
  `pnpm test:demo` and `pnpm test:build:demo`. Start the demo explicitly,
  check occupied-port failure without stopping someone else's service, then stop
  your demo and verify its temporary data is gone. Test the OS's normal interrupt.
- No production database, provider call, credential-store access, background service
  installation or deployment. Do not infer compatibility from another OS's result.
- Handoff: one PR with reproducible commands, exact OS/Node/pnpm versions, sanitized
  results, cleanup evidence and necessary portability fixes. No raw execution logs
  or one-time codes.

The maintainer completes release/privacy/licensing review and integration alongside
these batches. Controller deployment, live connectors and continuous pickup remain
separate packages with their stated prerequisites; they are not hidden work inside
either demo contribution. One public issue per cohesive package or OS assignment,
not one issue/PR per small code edit.

## Expansion after the core path

| Package | User outcome | Boundary |
|---|---|---|
| Claude Code adapter (proposed) | Claude Code users can contribute a connector using the same task/result contract | Not currently supported; confirm upstream interfaces, license and version before implementation |
| OpenClaw adapter (proposed) | OpenClaw users can integrate their harness without a second scheduler | Not currently supported; demonstrate capability discovery, scoped execution, results and interruption handling |
| Other harness adapters | Additional runtimes use the same project/job/evidence model | Propose a concrete maintained runtime and compatibility matrix; do not invent support claims |
| Idea Lab | Several agents discuss an idea, expose their reasoning and promote an inspected synthesis into ordinary project work | Use the existing discussion/project services; no automatic business deployment |
| News and research | Attributed articles become research, setup-guide or draft tasks and return reviewed results | Reuse curated-source and deduplication components; publishing is a separate permission |
| Generic content workflows | Optional content projects use reusable templates, review and artifact history | No private brands, datasets or credentials in examples; optional modules must not redefine the core |
| Accessibility and mobile operation | Owners can monitor and review across keyboard, desktop and mobile | Real interaction evidence, not screenshots alone; preserve current access boundaries |

## Claim and keep moving

1. Choose a **ready** package whose platform, dependencies and resources you have.
2. Comment with the intended scope and ask for assignment. Wait for maintainer confirmation;
   simultaneous comments do not create competing claims.
3. Use your own fork/branch. Agree on milestones for large packages and send one cohesive
   PR per independently reviewable outcome. Multiple local commits are fine.
4. Test locally. Include exact base/head, commands, observed results, relevant failure
   cases, upstream provenance/licenses and limitations. Do not upload private logs.
5. While a PR awaits review, pick another confirmed independent assignment. You do not
   need to wait idle, but avoid overlapping work or building on unmerged assumptions.
6. Fix ordinary mistakes in scope and rerun checks. If blocked, retain the work in a
   draft PR, explain the missing prerequisite, and request release/reassignment. Never
   repeat an uncertain provider or deployment action without appropriate authority.

Maintainers own security contracts, migrations, source-release review and final
integration. Reviewers do not approve their own changes. Merge permission is not
deployment permission. Contributor agents follow the same accountability rules.

## Actions and batching

Actions start disabled. No scheduled polling, automatic deployment, per-comment jobs,
or self-hosted runners attached to public pull requests. Run checks locally and batch
meaningful pushes and review requests. Small local commits are useful and do not consume
Actions minutes. Avoid huge unreviewable PRs solely to reduce commit counts.

Before enabling CI, a maintainer must approve its triggers, permissions, runner class,
concurrency/cancellation, retention and spending controls. Never run untrusted PR code
with repository secrets or privileged credentials. Standard public GitHub-hosted runners
are currently free; private repository allowances are runner minutes, not pushes/pulls.
See [GitHub billing guidance](https://docs.github.com/en/actions/concepts/billing-and-usage).
