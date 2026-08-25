# Control Room — Project-Agnostic Orchestration Architecture

**Status:** Architecture direction for the broader platform
**Core product:** Control Room
**First workspace/module:** Wayfarer Studio
**First production project:** Lo-Fi Wayfarer Lazy River Pilot

## 1. Product decision

Control Room will be a private, project-agnostic orchestration platform. Wayfarer Studio is its first workspace and media-production module, not the platform itself.

The core will coordinate projects, agents, workers, capabilities, queues, dependencies, artifacts, approvals, schedules, costs, notifications, and audit history without assuming that the work is a YouTube video. Domain-specific behavior will be supplied through project packs and worker adapters.

This provides expansion without prematurely building a generic plugin marketplace or a collection of microservices. The first implementation should be a modular monolith with clear internal contracts.

## 2. Naming and hierarchy

```text
Control Room                         entire private orchestration platform
  Workspace: Wayfarer Studio         Lo-Fi/video operations and policies
    Project: Lazy River Pilot        one defined outcome
      Pipeline: Ambient Journey      reusable workflow template
        Milestone / Work Item        human-visible work
          Job / Attempt              schedulable machine execution
            Artifact / Approval      evidence and authority

  Workspace: Websites                example future workspace
    Project: Site Redesign
      Pipeline: Build and Deploy

  Workspace: Future Channel
    Project: Winter Road Pilot
```

### Definitions

- **Control Room:** Global portfolio, workers, agents, capacity, policies, and navigation.
- **Workspace:** A durable operational area with its own members, credentials, adapters, storage rules, and defaults.
- **Portfolio:** Optional grouping of related projects inside or across a workspace.
- **Project:** A bounded objective with priority, status, dates, budgets, and success criteria.
- **Pipeline:** A reusable, versioned graph or template for how a type of work proceeds.
- **Work Item:** A human-visible unit with dependencies, evidence, review, and status.
- **Job:** A schedulable execution request with precise capability and resource requirements.
- **Attempt:** One worker's execution of a job under a lease.
- **Artifact:** A versioned output or evidence object, not necessarily media.
- **Agent:** A Hermes or other reasoning identity authorized to take defined actions.
- **Worker:** A machine/runtime that deterministically executes compatible jobs.

Workers and agents are global resources but receive scoped workspace/project grants. A machine may host several Hermes profiles and one worker runtime; these remain separate identities.

## 3. Core versus project-specific behavior

### Control Room core

The core owns:

- identities, roles, permissions, and scoped credentials;
- workspaces, portfolios, projects, milestones, and generic work items;
- dependency graphs, states, priorities, deadlines, and budgets;
- agents, workers, capabilities, schedules, health, and performance;
- queues, leases, attempts, retries, reservations, and cancellation;
- generic artifacts, versions, checksums, locations, evidence, and provenance;
- comments, questions, reviews, approvals, and audit events;
- notifications and Telegram action handling;
- global/project capacity allocation, bottlenecks, forecasts, and history;
- adapter and project-pack registration.

The core must not contain hard-coded assumptions such as biome, frame range, Unreal preset, audio stem, website deployment, or YouTube episode.

### Project packs

A project pack supplies domain behavior while using the core primitives. It may include:

- project and pipeline templates;
- custom fields and validation schemas;
- work-item and artifact types;
- capability definitions;
- review rubrics and specialized review components;
- deterministic QC rules;
- worker adapter declarations;
- dashboards and KPIs relevant to that domain;
- notification templates;
- permissions and policy defaults.

Initial packs could be:

| Pack | Examples |
|---|---|
| Wayfarer Media | Unreal renders, scenes, audio candidates, QC, review, assembly, YouTube package |
| Website Operations | GitHub issue/build/test/deploy/health-check workflow |
| Content Pipeline | Research, drafting, review, assets, scheduling, publication |
| General Automation | Scripts, data processing, backups, transfers, recurring operational work |

Only Wayfarer Media needs full implementation for the first production release. The Phase 1 prototype should simulate a second, unlike project type to prove that the core is not media-bound.

## 4. Global Control Room experience

The top navigation begins with an **All Projects** scope selector. The user can switch among:

- All Projects;
- one workspace;
- one portfolio;
- one project;
- saved views such as Needs Me, At Risk, or Running Now.

The selected scope filters Control Room, Productions, Review, Workers, Capacity, Assets, Activity, and reports without changing the underlying records.

### All Projects home

The global view should answer:

- What is running across everything?
- Which projects are healthy, at risk, blocked, or paused?
- What needs the user's decision now?
- What is each agent and worker doing?
- Where is capacity unused?
- Which project owns the current system-wide bottleneck?
- Which deadline or objective is most at risk?
- What allocation change would help most?

Suggested default sections:

1. Needs Your Attention
2. Active Projects and forecasted completion
3. Running Now by worker and agent
4. Global Bottlenecks
5. Capacity Allocation by project
6. Recent Completions and Failures
7. Evidence-backed Recommendations

### Project drill-down

Selecting a project opens the familiar detailed environment:

- project summary and target;
- milestones and dependency graph;
- Kanban/list/timeline views;
- workers and agents contributing to the project;
- project-specific bottleneck and forecast;
- review items and decisions;
- artifacts and history;
- allocation and budget policies.

Wayfarer Studio therefore remains essentially as designed, but it appears inside a larger Control Room scope.

## 5. Worker and agent allocation

### Worker allocation modes

Each worker or capability can be configured as:

- **Exclusive:** Only one project or workspace may use it.
- **Preferred:** Prefer one project, but lend idle capacity elsewhere.
- **Shared:** Allocate across eligible projects according to policy.
- **Opportunistic:** Use only when no higher-priority work can use it.
- **Manual:** Accept no new job until the user explicitly assigns or releases it.

Assignments can apply to the entire machine or one capability. For example, the Windows PC's Unreal capability can prefer Wayfarer while its transfer and proxy capabilities remain shared.

### Agent allocation modes

Hermes profiles can similarly be:

- dedicated to one workspace/project;
- shared across approved projects;
- scheduled for defined time windows;
- activated only when matching questions/jobs exist;
- used as manager/reviewer identities with independence rules.

The platform records both assignment and actual contribution. It can distinguish an agent that was unavailable, lacked matching work, waited on a dependency, or simply was not selected.

## 6. Cross-project scheduling policy

Control Room should not use a purely greedy algorithm. Greedy scheduling can let one busy project consume every worker and starve quieter or deadline-sensitive projects.

The recommended scheduler is hierarchical and policy-driven.

### Step 1 — Hard eligibility

Remove jobs that cannot run because of:

- missing verified capability;
- permission or workspace boundary;
- insufficient live resources or storage reservation;
- incompatible version/platform;
- dependency or approval not satisfied;
- schedule, maintenance, health, or budget restriction;
- unavailable required data or credential.

### Step 2 — Project allocation

Eligible projects receive weighted fair shares, for example:

```text
Wayfarer production       60%
Website operations       25%
Experiments/research     15%
```

These are targets, not wasted reservations. If Website Operations has no eligible work, Wayfarer may borrow its unused capacity. When website work returns, fair-share debt causes capacity to rebalance at safe job boundaries.

Projects can also have:

- minimum guaranteed share;
- maximum share;
- maximum concurrent jobs;
- deadline/urgency policy;
- daily/weekly compute or cost budget;
- quiet hours;
- exclusive or preferred workers;
- pause, hold, or manual-only state.

### Step 3 — Job selection inside a project

Within the chosen project, jobs receive a composite score based on:

- critical-path impact;
- priority and deadline risk;
- queue age to prevent starvation;
- number/value of downstream jobs unlocked;
- worker affinity and cached/local inputs;
- estimated duration and checkpoint cost;
- failure/retry risk;
- user pin or explicit override.

The exact weights remain configurable and observable. The system should display why a job won rather than hiding the decision in an opaque score.

### Step 4 — Safe execution

- Heavy renders and destructive/irreversible work are not interrupted arbitrarily.
- Rebalancing occurs at chunk, frame-range, checkpoint, or job boundaries.
- Lightweight jobs may support safe pause/resume.
- User overrides are immediate for queued work and drain-based for running work.

This produces fair sharing without sacrificing critical-path progress or corrupting long jobs.

## 7. Portfolio-level capacity and bottlenecks

Capacity analysis exists at three scopes:

1. **Global:** What limits all active projects collectively?
2. **Workspace/project:** What limits this specific objective?
3. **Worker/capability:** Why is this resource busy, idle, degraded, or unavailable?

### Global resource matrix

| Worker/capability | Wayfarer | Websites | Other | Current state |
|---|---:|---:|---:|---|
| RTX Unreal render | Preferred | — | Opportunistic | 96% utilized |
| M4 video encode | 60% | 20% | 20% | 42% utilized |
| VPS scheduling | Shared | Shared | Shared | Healthy |
| Vision reviewer | 70% | 30% | — | Queue growing |

### Example global finding

```text
System-wide constraint: RTX Unreal rendering

Wayfarer is delayed 31 hours by the constraint.
Other projects are not waiting for this capability.

Reassigning general workers will not help.
Enabling verified M4 final rendering is estimated to recover 8 hours.
Adding memory to the website worker has no effect on the critical path.
```

### Allocation recommendations

The system may recommend:

- lend an idle worker/capability to another project;
- change a project's fair share temporarily;
- move work closer to cached data;
- install a missing adapter on a suitable idle machine;
- shift a deadline or reduce a render preset;
- change availability hours;
- add storage, memory, GPU, or cloud capacity only when evidence supports it;
- pause low-value work that blocks a higher-value deadline.

Recommendations show evidence, assumptions, confidence, projected benefit by project, and any tradeoff imposed on other projects. AI may explain and propose; deterministic policy and user authority decide.

## 8. Generic data model changes

The platform schema should use generic primary entities:

- Organization/Owner;
- Workspace, Portfolio, Project, ProjectTemplate, PipelineVersion;
- Milestone, WorkItem, Dependency, Job, Attempt, Lease;
- AgentIdentity, WorkerNode, Capability, CapabilityVerification;
- AllocationPolicy, ProjectShare, AvailabilitySchedule, Reservation;
- Artifact, ArtifactVersion, ArtifactType, StorageLocation, Evidence;
- ReviewPolicy, ReviewItem, Finding, Comment, Question, Decision, Approval;
- AdapterDefinition, ProjectPack, SchemaVersion;
- Notification, AuditEvent, CostRecord, Forecast, Recommendation.

Media concepts such as Episode, Shot, AudioProgram, EditorialTimeline, and Deliverable become Wayfarer-pack types or extensions rather than mandatory global tables.

All records include workspace/project scope where relevant, and cross-project data access is denied unless the acting identity has an explicit grant.

## 9. Telegram at portfolio scale

Telegram messages identify their scope clearly:

```text
WAYFARER STUDIO · Lazy River Pilot
Review ready: Forest transition v3
```

```text
WEBSITE OPERATIONS · Portfolio Site
Deployment approval requested
```

Useful commands/actions include:

- `/status` — global concise status;
- `/projects` — active project selector;
- `/needsme` — approvals/questions awaiting the user;
- `/workers` — running, idle, unhealthy, or offline workers;
- `/bottleneck` — current global constraint;
- pause/resume/reprioritize one project;
- temporarily lend a worker or capability;
- open the matching filtered Control Room or Mini App view.

Every action remains scoped, version-checked, permission-checked, idempotent, and audited by the same command service as the web UI.

## 10. Domain and deployment recommendation

Because Control Room now spans projects beyond Lo-Fi Wayfarer, the permanent private hostname should not be tied to `lofiwayfarer.com`.

Recommended structure after a neutral private domain is selected:

```text
control.<neutral-private-domain>     Control Room
lofiwayfarer.com                     public Wayfarer site
```

`studio.lofiwayfarer.com` can still be an optional redirect or deep link into the Wayfarer workspace, but should not be the canonical global host. No new domain needs to be purchased before the prototype; local and temporary VPS environments can be used first.

Connectivity is deliberately independent of any mandatory VPN. Workers use authenticated outbound HTTPS as the universal control path, with Tailscale/LAN as optional private paths and R2/local spooling as transfer/recovery mechanisms. See [CONTROL_ROOM_CONNECTIVITY_AND_VPN_PLAN.md](CONTROL_ROOM_CONNECTIVITY_AND_VPN_PLAN.md).

## 11. Revised build implications

The broader scope changes the first phases, not the entire delivery order.

### Phase 0 changes

- Define generic core objects before media-specific tables.
- Define project-pack and adapter contracts.
- Define global/workspace/project permission scopes.
- Define cross-project allocation policies and scheduler explanations.

### Phase 1 changes

The responsive prototype must include:

- All Projects selector and global home;
- at least two unlike simulated workspaces/projects;
- project drill-down into Wayfarer Studio;
- global worker/agent allocation matrix;
- per-project and global bottlenecks;
- manual worker preference/allocation control;
- an example fair-share scheduling explanation.

### Backend and worker changes

- Every job, artifact, decision, token, budget, and event is properly scoped.
- Worker capabilities remain global but permissions and allocations are scoped.
- The scheduler chooses a project fairly before choosing a job within it.
- Project packs register domain types and behavior through versioned contracts.

### What does not change

- Wayfarer remains the first real production use case.
- The M4 Pro, RTX 3070 PC, and VPS remain the first real nodes.
- Telegram remains a shared operating surface.
- Storage, review, audit, worker safety, and authority requirements remain.
- Cloud execution remains deferred until local production succeeds.

## 12. Guardrail against overbuilding

The platform should be generic at its seams but concrete in its first implementation:

- Build generic projects, work, artifacts, agents, workers, approvals, and scheduling.
- Fully implement one domain pack: Wayfarer Media.
- Simulate one second domain during prototype and scheduler tests.
- Add a second real pack only when there is an actual project ready to use it.
- Do not build a public plugin marketplace, multi-tenant billing system, or arbitrary workflow language in the MVP.

This preserves modularity while keeping the lazy-river pilot achievable.

## 13. First acceptance test of modularity

The Phase 1 prototype passes the architecture test when the user can:

1. open Control Room in All Projects mode;
2. see Wayfarer and a non-media project simultaneously;
3. see five agents/workers divided across them;
4. change one worker from exclusive to shared or preferred;
5. observe the forecast and bottleneck change;
6. drill into Wayfarer Studio and retain all previously designed worker, review, production, and capacity details;
7. return to All Projects without losing project context;
8. perform a scoped approval from Telegram that updates the correct project only.

Passing this before backend implementation proves the expansion is architectural rather than cosmetic.
