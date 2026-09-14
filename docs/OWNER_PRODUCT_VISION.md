# Agent Control Room: consolidated owner vision

**Status:** Product source of truth

**Updated:** September 14, 2026

**Audience:** Maintainers, contributors, agent builders and reviewers

This document consolidates what the owner has asked Agent Control Room to become.
It is intentionally written in plain English. `PRODUCT_REQUIREMENTS.md` translates
this vision into numbered, testable requirements.

The latest stated direction wins where an older idea conflicts with a newer one.
Private addresses, machine names, credentials and personal project data are
deliberately omitted. A private installation may supply them through configuration.

## The product in one paragraph

Agent Control Room is a self-hosted website where one person can organize projects
and coordinate many AI agents, coding harnesses and computers without manually
carrying messages between them. Each project has its own page. The owner can create
work, choose or allow eligible workers, watch honest progress, collect files and
answers, review results, request revisions and see what needs attention. Workers may
continue useful independent work while other results wait for review. The website,
not any individual bot, is the shared source of truth for assignments, permissions,
status, evidence and decisions.

## Product principles

1. **The owner remains in control.** A bot may propose or perform authorized work,
   but it cannot grant itself permission, approve its own consequential action or
   silently expand the task.
2. **Projects are the organizing unit.** Work, agents, files, reviews, decisions,
   activity and optional modules stay attached to the correct project.
3. **Many harnesses, one control plane.** Hermes Agent and Codex are the first
   required integrations. Claude Code follows through the same adapter contract.
   OpenClaw and other harnesses can be added without redesigning the core.
4. **One public product, not a private fork.** The owner's installation is the same
   open-source application configured for the owner's machines, branding, projects,
   limits and optional modules.
5. **Use proven components first.** Adopt or adapt maintained, permissively licensed
   code when it fits. Write custom infrastructure only when a recorded requirement,
   security boundary or integration mismatch makes that necessary.
6. **Truth is more important than appearance.** Unknown usage is shown as unknown,
   disconnected workers are not shown as active, tests are not described as live
   compatibility, and an agent saying “done” is not the same as accepted work.
7. **Fast group building without chaos.** Work packages should be substantial,
   non-overlapping and self-contained. Automatic claims prevent duplicate work;
   proportional independent review and maintainer integration protect quality.
8. **Safe recovery beats blind retry.** Lost replies, restarts and disconnects must
   reconcile existing work before the system creates another execution.
9. **Modular without becoming fragmented.** One application, one authoritative
   database and one scheduler serve optional project modules and adapter types.

## What the owner must be able to do

### See the whole operation

- Open a Home page showing running work, completed results, blocked or offline
  workers, important decisions and everything needing owner attention.
- Move directly from an alert to the exact project, task, result or approval.
- See current capacity, supported capabilities, platform, harness version, assigned
  work and honest resource/usage information for each worker.
- Use the Control Room from a desktop, phone or permitted work browser without
  keeping a terminal open or watching every agent continuously.

### Run separate projects

- Create an ordinary project at any time without writing code.
- Give every project a stable page and deep link that can be open in its own browser
  tab without confusing it with another project.
- View a project's overview, inbox, work, agents, automations, files, reviews,
  activity and settings.
- Complete, archive, reopen or close a project explicitly while preserving its
  history. Closing a browser tab must not cancel its work.
- Configure the modules, template, branding, sources, limits, review policy and
  eligible worker capabilities for each project.
- Add specialized project experiences through configuration and reviewed extensions
  instead of creating a separate Control Room product.

### Delegate and review work

- Write a task in plain language with the requested result, expected files,
  constraints, budget and review policy.
- See a recommended worker, model class and effort level for the job, understand the
  capability/cost tradeoff, and keep the final choice under owner or project policy.
- Let Control Room choose an eligible worker or select one manually.
- Appoint a project lead/orchestrator when useful. The lead may divide work and
  coordinate other workers only within the authority and limits granted by the
  project. Control Room remains the authority and record of what happened.
- Allow workers to discover and automatically claim eligible work without waiting
  for a person to relay or approve every claim.
- Let a capable worker hold several non-conflicting assignments and continue with
  other work while a completed result waits for review.
- Prevent two workers from unknowingly changing the same protected scope. Show who
  owns a task, lease or file area, when it expires and how it is handed back.
- Show platform, capability, difficulty, dependencies, allowed files/effects and
  completion tests before work is claimed. Include any required skill/procedure and
  recommended model/effort class. Do not hardcode personal bot names.
- Keep reusable worker and reviewer skills versioned, attributed and easy for bots to
  load. A skill explains the workflow but never grants additional authority.
- Let a worker report a reproducible blocker, release or hand off the assignment and
  move to other eligible work without pretending failure is success.
- Require proportionate independent review for significant contributions, followed
  by final maintainer integration. Workers do not approve or merge their own work.

### Follow a complete work lifecycle

- See proposed, queued, running, waiting for input, awaiting review, blocked, failed,
  uncertain, completed and accepted states.
- Receive progress and safe summaries without exposing raw credentials, private
  prompts or unrestricted host data.
- Receive bounded answers, files and evidence under the originating task and project.
- Review a result, accept it, reject it or request a revision while retaining the
  prior attempt and the exact relationship between versions.
- Distinguish a quality review from permission to publish, install, spend money,
  change production or take another consequential action.
- Reconnect after browser, network, worker or server interruption and recover the
  correct task without silently running it twice.

## Agent and machine connectivity

- Workers may run on macOS, Windows or Linux, including personal computers and a
  private server. Each machine keeps its own installation and credentials.
- A registered node connector communicates outbound with Control Room over an
  authenticated private route. The browser communicates with the web application.
  Harness adapters translate the shared task/result contract into each supported
  harness's real interface.
- Hermes and Codex on the same machine are separate registered workers even though
  they can share the local node service. They do not share provider credentials.
- Direct SSH between bots is not the source of orchestration authority. SSH or an
  upstream remote-sandbox transport may be used as a bounded implementation detail
  for a supported worker or artifact return path.
- Supported Hermes remote artifact return should be usable where available,
  including upstream SSH and remote-sandbox transports, while preserving project,
  task, provenance and size limits.
- MCP can expose Control Room services to compatible harnesses, but it must use the
  same permissions, queue and records as the website. It is not a second control
  plane or scheduler.
- Private networking such as Tailscale may simplify machine connectivity, but the
  product must not require one paid mesh-network vendor.
- Compatibility is published by exact harness version, operating system and proven
  capability. Unsupported start, resume, cancellation, usage or file transfer is
  shown honestly and fails safely.

## Multi-agent Idea Lab

- The owner can start a bounded idea discussion, choose several eligible agents and
  ask them to explore, challenge or improve a business or project idea.
- Distinct agent contributions remain visible; one synthesized answer must not erase
  disagreements, missing participants or failures.
- The discussion has explicit participant, round, time, usage and cost limits.
- The owner can compare contributions, ask a follow-up, record a decision and promote
  the result into a normal project with its own page and proposed first task.
- Promotion does not secretly start execution or authorize external action.
- Hermes Bot Mode rooms, routines and profiles may supply safe observations and
  participation through supported interfaces, but Control Room owns the project,
  assignment, approval and retained result records.

## AI and technology news workflow

- An optional project module curates AI and technology news from configurable,
  authorized sources.
- It reuses the selected Control Center discovery, ranking, freshness and reading
  behavior rather than rebuilding an inferior feed system.
- The owner can browse recent, important, historical and archived stories, see the
  original source and retained evidence, and archive or restore an item.
- From an article, the owner can prepare **Research this**, **Compare**, **Write a
  setup guide** or **Draft** work for a selected project.
- Newly discovered material stays clearly unverified. A verification-first research
  task must check primary sources, report uncertainty and return for owner review.
- Clicking an article must not automatically publish content, install software,
  contact a provider or execute remote setup.
- News collection uses the same database, scheduler, worker lifecycle, task flow and
  review system as the rest of Control Room.

## Web experience

- Use a calm, compact project workspace with readable text, clear status words and
  a single obvious primary action in each area.
- Provide global Home, Projects, Workers, Needs attention and Settings navigation.
  Idea Lab and News appear only when enabled.
- Preserve deep links, browser back/forward, reload and correct project isolation.
- At phone width, core actions remain usable without page-wide horizontal scrolling.
- Keyboard navigation, visible focus, labels, announced errors, readable contrast
  and common assistive technology must work before accessibility is called complete.
- Errors explain what happened, what was preserved and what safe action is available.
  A read-only re-check must look different from a retry that could execute work.
- Untrusted agent output is rendered safely. Files are bounded and protected; raw
  filesystem paths and agent-generated links never become download authority.
- Voice input and read-aloud are desired optional accessibility/productivity features.
  Voice uses the same task and approval boundaries as typed input and is not required
  to prove the first core release.

## Data, files and authority

- Production has one PostgreSQL primary as the sole global authority for projects,
  tasks, assignments, schedules, approvals, results, reviews and audit history.
- The intended private deployment uses a dedicated Control Room database and
  restricted roles on a privately reachable PostgreSQL server. AWS RDS is not the
  chosen production target.
- PGlite is for development and disposable tests only.
- Object storage such as Cloudflare R2 holds bounded artifacts and verified backups.
  It is not the job queue, lock service or transactional source of truth.
- Project records, credentials and private business data never enter the public
  source repository. Configuration exports contain only documented non-secret data.
- All important mutations have stable identity, replay protection, audit evidence
  and explicit project/tenant scope.
- Consequential effects require separate, current authorization. Network location,
  agent output, code review or a prior approval does not silently grant it.

## Private operation and security

- The public project website at `agentcontrolroom.xyz` explains the product and links
  to the public repository. It may identify maintainer Alastair Fraser, link to
  `agenticbotsitter.com` and publish the project contact address already shown in the
  repository. It contains no link or hint to the owner's private app.
- The private application uses one owner-selected hostname on a separate existing
  domain. Its exact address is private configuration, not public documentation.
- Cloudflare Tunnel provides outbound-only ingress and Cloudflare Access protects the
  human application. The origin is not directly reachable from the public Internet.
- Initial ownership is restricted to the exact owner identity. Cloudflare login plus
  authenticator-app MFA is required, with a practical remembered session on trusted
  personal devices. Logout, expiry, revocation and direct-origin denial must be tested.
- Machine connectors use separate, least-privilege credentials and routes from the
  human browser. No bot receives the owner's browser session.
- Security cannot depend on the private hostname being hard to guess. The unusual
  hostname is an additional privacy measure, not the lock.

## Installation, updates and everyday reliability

- A new operator can install one versioned release on a modest private Linux server,
  configure it without editing source and connect supported workers.
- The service runs as an unprivileged account under a persistent supervisor, binds
  only where intended and coexists with other websites and services.
- Installation, migration, update and rollback are documented, integrity checked and
  batched. Normal updates drain work, preserve uncertain operations, restart services
  and let browsers and workers reconnect without everyone shutting down manually.
- PostgreSQL migrations have forward and rollback/refusal rules. Backup is not called
  verified until a restore into a disposable database proves required data, ownership
  and restricted access.
- Artifact backup/restore, database backup/restore and release rollback are separate
  operations with clear evidence and recovery limits.
- Resource limits protect the server. Tests and jobs must not consume the entire
  machine or disrupt unrelated services.
- Health, worker staleness, queue backlog, failures, uncertainty and resource pressure
  are visible. Important changes can notify the owner without producing constant noise.
- Optional read-only session views may show bounded terminal or harness observations
  when useful, but they cannot become another command or assignment authority.
- Capacity, cost, usage history, model/effort choices and bottlenecks should help the
  owner decide where work goes without inventing unavailable measurements.

## Public project and community build

- The source is public under Apache License 2.0. Original copyright and attribution
  remain visible, including a NOTICE explanation that Agent Control Room is available
  as open source even if someone distributes a modified or closed product.
- Third-party code retains its original license and notices. License compatibility is
  checked before adoption; personal use is not treated as permission to ignore a
  license.
- The repository front page explains the product, current truth, roadmap, setup,
  contribution process and live work queue without requiring private folders.
- Humans and bots choose work by role, platform, capability and difficulty. Public
  issue packets contain everything needed to begin and finish.
- GitHub is the shared build desk until Control Room can run this workflow itself.
  Claims, progress, blockers, reviews and handoffs stay with the issue or pull request
  so the owner is not a message courier.
- Public product documents, examples, fixtures and saved handoffs use generic project
  and worker roles. They do not publish the owner's private project names, bot display
  names, machine names or private installation labels.
- Prefer a few substantial, coherent submissions over dozens of tiny jobs or commits.
  Automated checks run on meaningful pushes and pull requests, not wasteful schedules.
- The lead maintainer settles architecture, security and final integration. Other
  contributors own complete assigned outcomes and ordinary debugging.

## Reuse and extension direction

The project should continue using the settled component decisions rather than
restarting broad comparisons. Important directions include:

- pg-boss for PostgreSQL-backed jobs and schedules;
- supported Hermes interfaces for Hermes work and artifact return;
- the shared harness adapter contract for Codex, Claude Code and later harnesses;
- selected Control Center modules for news discovery, ranking and reading;
- existing protected Markdown/result components for results and reviews;
- Cloudflare Tunnel and Access for private ingress and human authentication;
- PostgreSQL and R2 for their separate authoritative-data and artifact roles; and
- optional Herdr-style read-only observation only when it replaces a real remaining
  monitoring need without becoming another source of task authority.

## Release priorities

### First usable public release — must work for real

1. Install one generic Control Room release on a private Linux server.
2. Configure it without source edits.
3. Sign in through protected browser access.
4. Connect and qualify at least two different supported harnesses, initially Hermes
   and Codex, with exact supported capabilities.
5. Create two isolated projects and assign real work.
6. Run a task, see truthful progress, receive bounded results/files, review them and
   request a revision.
7. Continue other eligible work while one result waits for review.
8. Reconnect after interruption without duplicate execution.
9. Restart/update safely and restore verified database/artifact backups.
10. Use the core experience from desktop and phone with keyboard-accessible controls.

### Next product modules

- Complete real multi-agent Idea Lab participation and promotion.
- Complete live news collection and article-to-research/guide/compare/draft journeys.
- Complete recurring work, reusable procedures/skills and richer capacity planning.
- Qualify additional platforms and harnesses, including Claude Code and community
  adapters, without weakening the shared contract.
- Add optional voice input/read-aloud, notifications, richer file/diff/media review
  and read-only session observation.

### Later scale and polish

- Multi-user/team roles beyond the initial owner deployment.
- More sophisticated scheduling, forecasting, cost optimization and incident views.
- Additional approved artifact transports and project-pack ecosystems.
- Public beta claims only after sustained everyday operation, upgrade and recovery
  evidence—not merely a large automated test count.

## Explicit non-goals and superseded ideas

- Do not create a separate private codebase for the owner.
- Do not use the public project domain as the private application login.
- Do not publish the private hostname or link to it from the public site.
- Do not publish private project names or personal bot display names in product
  documentation, examples, fixtures or handoff artifacts.
- Do not build a custom username/password or MFA system when Cloudflare Access meets
  the requirement.
- Do not use AWS RDS for the selected deployment.
- Do not use R2, local files or agent-to-agent messages as global coordination state.
- Do not modify Hermes merely to make Control Room tests pass.
- Do not make direct SSH bot-to-bot messaging the orchestration architecture.
- Do not add another scheduler, database, proxy, terminal multiplexer or monitoring
  system when the selected component already performs the needed job.
- Do not claim every harness, platform, optional module or live effect works merely
  because the public architecture is extensible.
- Do not delay the real mixed-harness core release for voice, elaborate dashboards,
  every possible adapter or other optional polish.

## What “finished” means

Control Room is not finished when its screens look complete or its simulated tests
pass. The first release is finished when an independently reviewed, versioned build
can be installed from public instructions and the complete real workflow above is
demonstrated with retained evidence, safe failure/recovery behavior and no hidden
private source changes. Optional modules may follow, but their navigation must remain
hidden or honestly unavailable until their backing service works.
