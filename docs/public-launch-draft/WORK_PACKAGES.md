# Contributor work packages

Draft for the first runnable public source release. These are substantial outcomes,
not currently assigned or ready-to-claim issues. A maintainer must add the exact public
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
