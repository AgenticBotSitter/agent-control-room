# Agent Control Room roadmap

For the September 8 component choices, implementation order and substantial
contributor batches, read [component decisions](COMPONENT_DECISIONS.md) and
[implementation packages](IMPLEMENTATION_PACKAGES.md). Selected does not mean
integrated; each package identifies missing public prerequisites before assignment.

Pre-alpha roadmap. The source preview supplies a disposable demo; independent setup
reproduction and live multi-machine acceptance remain open. These milestones preserve
the full product direction, not release dates or claims of supported configurations.

## What finished should look like

Create a project, send useful work to a suitable agent, follow progress, open its result,
ask for a revision and review the revised work—all from that project's page. Other
eligible work can continue while results await review. You can use different runtimes
on different machines without relaying every message or sharing their credentials.

Ideas, articles and content workflows become work in those same projects. A global
attention view shows decisions and problems without replacing individual project pages.

## 1. Reproducible contributor release

**Deliver:** A reviewed source tree, attribution, development instructions and a clearly
labeled disposable demo. Keep private records, infrastructure configuration and history
outside the public release.

**Done when:** Someone without maintainer access can start from a clean checkout, prepare
the pinned dependencies, run documented checks and complete the documented synthetic
project/task/result/revision flow. The demo distinguishes simulated work from real agents,
preserves history through browser refresh within a running session, and has bounded
cleanup instructions. Process restart intentionally begins a new disposable demo;
durable application recovery belongs to the operational milestones below.

**Useful contributions:** Setup-guide reproduction, accessible project/task controls,
error/retry usability, generic fixtures and attribution review. Source selection and
license/privacy acceptance remain maintainer-led. A website announcement alone does not
complete this milestone.

## 2. One genuinely usable private installation

**Deliver:** Configured owner access, one private PostgreSQL primary, separate approval
key custody, independent review-integrity storage, one supported connector and the full
task-to-result path. Reuse the existing queue and application services.

**Done when:** On an explicitly authorized installation, a real task reaches a real agent,
returns the correct files, receives a review and completes a linked revision. Refresh,
permission expiry and lost responses do not duplicate execution or expose another project's
data. A review-quality decision never becomes blanket execution permission.

**Useful contributions:** Connector packaging, installation documentation, result display,
reproducible failure cases and platform-specific validation. Credentials, database
provisioning, security architecture and live attempts require explicit maintainer scope.
Unit tests or an in-memory integrity checkpoint cannot substitute for operational evidence.

## 3. Productive workers across machines

Hermes and Codex are the initial priority. Claude Code and OpenClaw are proposed
community adapter tracks, not supported configurations today. Other harnesses can
propose adapters against the same reviewed contracts. See [work packages](WORK_PACKAGES.md).

**Deliver:** Qualified platform/runtime combinations, independently registered workers,
continuous eligible pickup, bounded concurrency and useful status/recovery reporting.

**Done when:** Several independent tasks progress while earlier results await review.
Disconnect and reconnect a worker without repeating uncertain work. A worker declines
unsupported tasks before starting. Cancellation affects only its intended run; revoked
access stops new authorized work. Failed tasks can be handed back with useful evidence.

**Useful contributions:** Platform installers, documented runtime-version checks, usage
reporting, reconnect tests, per-node limits and operator troubleshooting. Support is
recorded per tested OS/runtime/version combination, not inferred from a package compiling.

## 4. Ideas, research and content on the same core

**Deliver:** Bounded multi-agent idea discussions, news/article curation and generic
content workflows, all using ordinary project tasks and existing permissions.

**Done when:** Several real participants explore an idea within limits; the user inspects
the synthesis and promotes it to a project with its own page and follow-up work. Selecting
an article can create a research or setup-guide task whose reviewed output returns to
the correct project. Disabling an optional workflow leaves ordinary projects usable.

**Useful contributions:** Discussion navigation, source attribution/deduplication, article
selection, project promotion and domain-specific input/output templates. Preserve existing
upstream notices. Do not add a parallel scheduler or automatically publish generated content.

Idea Lab and news/research remain intended product scope even if they follow the first
usable core. They are optional installation choices, not features abandoned to declare success.

## 5. Dependable daily operation

**Deliver:** Accurate attention handling, backup/restore, updates, rollback and sustained
desktop/mobile usability, with documented supported configurations.

**Done when:** A sustained trial exercises normal work and failures. Restores preserve
the intended integrity guarantees. An update drains or preserves in-flight work as
documented; clients reconnect and old/new components handle version mismatches clearly.
A failed update has a tested rollback procedure. Uncertainty is actionable, not shown
as success or hidden behind a stale green indicator.

**Useful contributions:** Keyboard/mobile tests, actionable error copy, long-running
rehearsals, update/restore documentation and exact-version compatibility evidence.
Do not promise zero downtime where a migration or protocol change requires a pause.

## Parallel work and acceptance

Independent UI, documentation and fixture work can proceed while maintainers complete
runtime setup. Contributors can hold several assigned independent issues and submit
separate PRs while earlier work is reviewed. Declare dependent branches so they can be
integrated in order. A ready issue must specify its public base revision, platform,
prerequisites, reviewing maintainer, scope and completion checks before assignment.

Prefer a proven component with a small adapter over custom infrastructure. A proposal
for new infrastructure must explain the missing requirement, alternatives considered,
license fit and maintenance cost. Tests support acceptance; file counts, elapsed effort
and numbers of green checks do not establish product completion.

## Collaboration and build budget

Run ordinary checks locally and batch meaningful changes. Do not add scheduled builds,
automatic per-push deployment, private-host runners or paid usage without maintainer
approval. Review can happen asynchronously without triggering a workflow every time
someone comments or pushes a small fix. Merge, deployment and live execution are separate.
