# Agent Control Room: public roadmap

This is the phase-level roadmap for the public product. It says what each phase
delivers, what must be true before the next one starts, and how the project's
autonomy grows. It deliberately contains no dates, no estimates and no
infrastructure specifics: those live in the private installation and in the
issue packets that carry the work.

Read it alongside:

- [Owner product vision](OWNER_PRODUCT_VISION.md) — what the product is for.
- [Product requirements](PRODUCT_REQUIREMENTS.md) — the numbered requirements and
  their priority terms.
- [Local to multi-system execution plan](LOCAL_TO_MULTI_SYSTEM_EXECUTION_PLAN.md) —
  how one machine becomes several.
- [Design: multi-agent pipelines (Phase 4)](https://github.com/AgenticBotSitter/agent-control-room/pull/363)
  — the pipeline design, still in review.
- [Work packages](../WORK_PACKAGES.md) and the repository
  [roadmap](../ROADMAP.md) for how work is actually assigned and accepted.

Everything here is aspirational. A phase is not done because code exists; it is
done when the acceptance evidence in its own section exists.

## 1. The product, in one paragraph

Agent Control Room is a self-hosted website where one person organises projects
and coordinates many AI agents, coding harnesses and computers without carrying
messages between them by hand. Each project has its own page. The owner creates
work, chooses or lets eligible workers pick it up, watches honest progress,
collects files and answers, reviews results, asks for revisions and sees what
needs attention. The website — not any individual agent — is the source of truth
for assignments, permissions, status, evidence and decisions.

## 2. The four layers

| Layer | What lives there | Where it lives |
| --- | --- | --- |
| **Public core** | Projects, tasks, agents and workers, pipelines, review, files, access, backups, install and update, Home, Needs Attention | This repository, Apache-2.0 |
| **Module system** | The seam for adding project types, pages and workflows without changing core authority ("project packs") | This repository |
| **Optional modules** | Domain features built on the module system: idea and research workflows, content and media workflows, recurring work, read-only session views | Decided per module; published as optional examples or kept private |
| **Private installation** | One operator's machine names, connections, hostnames, runbooks, limits, branding and personal projects | A private repository and a protected folder on their own machine |

The public repository holds the generic product only. An operator's names,
machines, connections and data live in their installation, never in the source
tree. The name guard in `scripts/check-private-names.mjs` enforces the
separation; see [contributing](../CONTRIBUTING.md).

## 3. Rules that do not change between phases

These hold in every phase. They are the short form of the security and
authority contracts, and they are what makes adding agents safe.

1. **The Control Room database is the only authority.** Agent chat, group chats
   and messages are transports, never records.
2. **Accepting a result is not approving an action.** Merging, publishing,
   spending and production changes need a separate, current approval.
3. **No agent approves or merges its own work.** Review is independent, and
   independent across model families where the product can arrange it.
4. **Never run anything twice silently.** After any doubt, reconcile first, and
   show "uncertain" honestly rather than guessing.
5. **Agents get no general shell.** They use typed, limited executors, and
   secrets are resolved only on the machine that uses them.
6. **Truth over appearance.** Unknown shows as unknown. A module stays hidden
   until it really works.
7. **One product, one database, one scheduler.** No second control plane; MCP,
   SSH and chat are transports into the same authority.
8. **The public repository is the generic product.** Personal configuration is
   configuration, not source.

**The ordering principle behind everything below:** safety before freedom.
Ownership leases come before more agents, reviewer independence comes before
cross-review, a separate owner approval key comes before any auto-acceptance,
and staged updates come before self-deployment. Each rung of the autonomy ladder
is switched on only after the thing that makes it safe exists.

## 4. The autonomy ladder

Each rung needs the safety features listed before it is switched on. The ladder
is the answer to "how much may an agent do without asking": nothing below is a
promise, it is a sequence of preconditions.

| Rung | What agents may do | Needs first | Unlocked by |
| --- | --- | --- | --- |
| **R0 — propose** | Draft tasks and plans only | Nothing | Available now |
| **R1 — build to a pull request** | Work on their own branch and open a pull request; nothing merges | Automated tests, CI, the private-name guard | Available now (CLI bridge) |
| **R2 — cross-review** | One agent reviews another's pull request; a maintainer reviews; the owner merges | Reviewer-independence rules | Phase 2 |
| **R3 — run inside Control Room** | Tasks and pipelines run as Control Room work, with results reviewed in the website | Pipelines, ownership leases, the Action Inbox | Phase 4 |
| **R4 — auto-accept low-risk work** | Documentation and tests can be accepted without a human, per project, and only where the owner allows it | The separate owner approval key, verified backups | Phase 6 |
| **R5 — self-deploy to an installation** | A merged change can be rolled out to an installation | Staged update with automatic rollback | Phase 8 |

A parallel ladder governs how many agents may work at once. Until ownership
leases exist, extra agents are safe only by convention — disjoint file areas and
manual coordination. Once leases and disjoint-scope checks land, more agents can
share a project, and once remote workers are proven, the limit becomes
scheduler and capacity limits rather than caution. **Agents are added after the
phase that makes collisions impossible, not before.**

## 5. The phases

Each phase lists what it delivers, how it is reviewed and tested, and its risk.
The test levels are: **A** automated tests, **B** rehearsal on throwaway
setups, **C** the live check with the owner.

### Phase 0 — first usable release

**Delivers:** the end-to-end local journey (create a project, run one real task
per agent from the website, collect a result), a short owner guide, and honest
database-down reporting.

**Accept:** A — CI green. B — a multi-agent rehearsal. C — one real task per
agent, live, with the owner watching.

**Risk:** medium. The first time the whole path runs for real.

### Phase 1 — foundations: dependable, separated, documented

**Delivers:** the public/private separation and the name guard; new projects
without a restart and no artificial project cap; persistent sign-in across
restarts; start-at-login; recovery from sleep, network drops and database
restarts; **verified backups with a real restore test**; resource limits;
test-database cleanup; a truthful README and owner guide.

**Accept:** A — guard, restart and backup tests. B — kill-and-restart
rehearsals and a restore into a disposable database. C — the owner approves
start-at-login once and does a sleep/wake check.

**Risk:** low to medium. The unglamorous phase that makes everything later
defensible.

### Phase 2 — core workspace: what a daily user needs

**Delivers:** **Home, Needs Attention and the Action Inbox**; the full project
sections (overview, inbox, work, agents, files, reviews, activity, settings);
project lifecycle (complete, archive, reopen) with history preserved; the
activity feed; honest loading, empty and error states with a visually distinct
"re-check" versus "retry"; protected file download and preview; revisions as
linked new work; a separate human verification step; a keyboard and accessibility
pass; and **reviewer independence**, which unlocks rung **R2**.

**Accept:** A/B — real-page browser tests of every page, not component tests. C
— the owner uses it for a day of real work.

**Risk:** medium. Much of this code already exists but is not yet visible in the
product.

### Phase 3 — access from other devices, and model choice

**Delivers:** secure remote access from trusted networks and devices; phone-width
usability; **per-task model and effort choice**; named model profiles; honest
usage and cost reporting; a recommended worker, model and effort shown before
assignment; and **ownership leases with disjoint scopes**, so more agents can join
safely.

**Accept:** A — an unlisted model is refused, and lease collisions are refused.
B — phone-sized full journeys. C — the owner works from a phone and a desktop,
and runs one task per agent on a chosen model.

**Risk:** medium. The phase that makes collaboration safe to scale.

### Phase 4 — multi-agent pipelines

**Delivers:** pipelines of ordered stages (plan → build → check → sign-off),
each stage with its own role, agent, model and effort; automatic hand-off between
stages; loops with limits; saved templates; **the project lead / orchestrator**;
several assignments per worker, with capacity released while results await review;
blocker reporting and hand-off; versioned skills and procedures; **isolated
worktrees for coding agents, with diff evidence for review**, so pipelines can
build code including Control Room itself; and a session-watch view across agents.
This unlocks rung **R3**.

**Accept:** A — stage hand-off, loop limits, refusal of self-approval, crash
recovery mid-pipeline. B — a multi-stage, multi-agent pipeline with a forced
failure. C — the owner runs a real pipeline on a small real job.

**Risk:** highest. New territory, so it is built in small reviewed steps. See the
[pipeline design in review](https://github.com/AgenticBotSitter/agent-control-room/pull/363).

### Phase 5 — more machines

**Delivers:** remote worker enrollment, result delivery and reconnect, with the
code that already exists activated and proven; worker revocation and refusal of
mismatched versions; connectors for additional platforms; a connection-centre
page; hardware and capability discovery; and moving the website and coordinator
onto an always-on private host, after which a desktop machine becomes a worker.

**Accept:** A — identity, revocation and replay. B — a two-machine throwaway
rehearsal. C — the owner sets up each machine once, then runs a pipeline across
machines, including a machine restarting mid-run.

**Risk:** high. The first live remote workers.

### Phase 6 — safety for autonomy

**Delivers:** **a separate owner approval key for consequential actions** — an
owner-present issuer — which unlocks rung **R4**; per-project budgets and
approval thresholds; cost ceilings where metering exists; **notifications** on a
channel the owner chooses; monitoring and health that treat "unknown" as unknown;
and owner focus priority pins.

**Accept:** A — forged or expired approvals are refused. B — a simulated
overnight run with budgets. C — the owner sets up the approval key, budgets and
notifications.

**Risk:** medium to high. Security-critical, so it gets an extra independent
review pass.

### Phase 7 — access from anywhere

**Delivers:** outbound-only tunnel ingress with an identity-aware access proxy
and multi-factor authentication on a private hostname; remembered sessions on
trusted devices; strict separation of browser and machine identities. A
non-overlay route is offered so the product does not require any particular
overlay network.

**Accept:** A — direct origin access is refused. B — a test tunnel. C — the
owner reaches it from mobile data.

**Risk:** medium. Correct ingress is easy to get subtly wrong.

### Phase 8 — autonomy: Control Room builds itself

**Delivers:** a work queue with self-claiming by eligible agents; continuous
queue-stocking of proposed work; a morning summary; **MCP exposure**, so agents
can create and track Control Room tasks; supplemental automated code review; and
**staged updates with drain, health check and rollback**, which unlocks rung
**R5**.

**Accept:** B — a simulated night of many tasks. C — a real night, with morning
reviews becoming routine.

**Risk:** medium. The first phase run mostly by the product itself.

### Phase 9 — the public product, alongside Phase 8

**Delivers:** a Linux install from a public release; running as an unprivileged
service; documented migration rules; license, NOTICE and an SBOM; a public work
queue with atomic claims; the adapter SDK and a conformance kit; a public
information site; and the non-overlay access route.

**Accept:** a clean-room operator completes the documented install and connects
a supported worker without editing source.

**Risk:** low to medium.

### Phase 10 — optional modules

**Delivers:** the module system is already in place by Phase 9, so each optional
module is a project pack rather than a fork. Examples of what operators build or
enable on it:

- **Idea and discussion workflows** — bounded multi-agent exploration of an
  idea, with a synthesis the owner inspects and promotes to a project.
- **News and research workflows** — article curation, source attribution and
  deduplication, and "research this" tasks whose reviewed output returns to the
  correct project.
- **Content and media workflows** — template-driven generation with a review
  step. Generated content is never published automatically.
- **Recurring work and schedules** — a module because scheduling is policy, and
  policy belongs in a reviewed module rather than the core.
- **Read-only session viewing** — bounded observation of a running session, off
  by default, which can never become a second command or assignment authority.
- **Voice input and read-aloud** — off by default.
- **Group chat views and an agent roster** — a view over existing records, not a
  new authority.

**Accept:** each module proves it can be disabled while ordinary projects stay
usable, and adds no parallel scheduler.

### Later: scale and polish

Multi-user and team roles; forecasting and cost optimisation; more artifact
transports; GPU and resource scheduling; bottleneck dashboards;
password-manager brokers; an evaluation of external open-source agent tooling for
reuse; and a public beta, only after sustained real use.

## 6. Why this order

- **Safety before freedom.** Leases (Phase 3) before more agents; reviewer
  independence (Phase 2) before cross-review; the approval key (Phase 6) before
  auto-acceptance; staged updates (Phase 8) before self-deployment.
- **Daily usefulness early.** Home, Needs Attention, the Action Inbox and other
  device access (Phases 2–3) make Control Room something an owner actually uses,
  which is also how defects surface.
- **Pipelines before more machines.** Most of the multi-agent value is available
  on one machine with a few agents. More machines multiply it later.
- **Activating existing code is cheaper.** Several features have substantial code
  that has never run for real. They need wiring and proof, not rebuilding — and
  they carry the same hidden-gap risk as new code.
- **Modules last, but ready.** The module system lands before the optional
  feature work, so domain features plug in without forking the product.
- **One control plane, always.** No phase introduces a second scheduler, queue,
  database, review path or approval path.

## 7. How work is assigned and accepted

- Work arrives as issue packets that state the public base revision, platform,
  prerequisites, reviewing maintainer, scope and completion checks.
- Humans and bots choose work by role, platform, capability and difficulty.
  Automatic claims prevent duplicate work.
- Every work packet must run its repository checks and
  `scripts/check-private-names.mjs` with the configured private-name list before
  it can be proposed for merge.
- Review is proportional and independent. Merge, deployment and live execution
  are separate decisions, and this roadmap authorises none of them.
- Prefer a proven, permissively licensed component with a small adapter over
  custom infrastructure. New infrastructure must name the requirement it serves,
  the alternatives considered, its license fit and its maintenance cost.
- Tests support acceptance. File counts, elapsed effort and a long list of green
  checks do not establish that a phase is done.

## 8. Open decisions for the owner

Recorded rather than resolved, because they are the owner's calls:

1. Whether a locally-trusted desktop coding agent may run on the owner's own
   installation, while the stronger public-product gate remains.
2. Which sign-in method applies where, given that a local owner code and an
   identity-aware access proxy solve different problems.
3. Whether any overlay network is ever required for a supported installation.
4. Which channel notifications use.
5. Which optional modules are published as public examples and which stay
   private.

