# Agent Control Room product requirements

**Version:** 1.0 draft

**Updated:** September 14, 2026

**Source:** `docs/OWNER_PRODUCT_VISION.md`

**Applies to:** The public, configurable Agent Control Room product

This document turns the owner vision into requirements that builders and reviewers
can test. It does not claim the requirements are already implemented.

## Priority terms

- **MVP:** Required before the first usable public release is accepted.
- **Next:** Required for the next major product modules after the core release.
- **Later:** Intended direction; must not delay the MVP.
- **Always:** A rule that applies to every release and contribution.

“Proven” means the stated behavior was exercised at the same boundary being claimed.
A simulated test cannot prove a live harness, network, browser login or production
restore. Every requirement that depends on an external system must publish the exact
tested version and limitations.

## 1. Product and architecture

| ID | Priority | Requirement | Acceptance evidence |
| --- | --- | --- | --- |
| ACR-001 | MVP | Provide one self-hosted web application for projects, workers, tasks, results, reviews, files, schedules, approvals and evidence. | One installed release exposes the required protected screens and services from one application lifecycle. |
| ACR-002 | Always | Ship one public core. Private installations differ through configuration, data and optional extensions—not source forks. | The same built artifact runs two isolated configurations without rebuilding or leaking data between them. |
| ACR-003 | MVP | Use a modular-monolith architecture for the first release. | One application and documented internal modules replace duplicate project, queue, auth or review services. |
| ACR-004 | Always | Keep Control Room—not an individual bot—as the authority for assignments, permissions, state and decisions. | Attempts to substitute agent output, room messages or connector state for canonical authority are refused. |
| ACR-005 | Always | Use versioned, harness-neutral interfaces for tasks, identities, progress, results, revisions, files and capabilities. | Hermes and Codex pass the same conformance scenarios while reporting their different supported capabilities. |
| ACR-006 | Always | Reuse selected maintained components and record why any custom infrastructure is necessary. | Component ledger names source revision, license, fit, adaptation, tests and attribution for every borrowed component. |
| ACR-007 | Always | Do not introduce a second database, scheduler, authorization plane or source of job truth for an optional module. | Architecture and integration tests show Idea Lab, News, MCP and adapters use the common services. |

## 2. Projects and customization

| ID | Priority | Requirement | Acceptance evidence |
| --- | --- | --- | --- |
| PROJ-001 | MVP | Let the owner create an ordinary project without writing code or first using Idea Lab. | Browser journey creates and reopens a project through the real protected application. |
| PROJ-002 | MVP | Give every project a stable page and deep URL suitable for a separate browser tab. | Two project tabs retain correct scope through navigation, reload and back/forward. |
| PROJ-003 | MVP | Show Overview, Inbox, Work, Agents, Files, Reviews, Activity and Settings; show Automations only when supported. | Each enabled section has a real route and backing service; unavailable sections are hidden or explicitly unavailable. |
| PROJ-004 | MVP | Prevent data from one project appearing in another after navigation or delayed replies. | Two-project tests cover late reads, writes, results, files, drafts and route changes. |
| PROJ-005 | MVP | Support explicit project completion, archive, reopen and close while preserving history. | A completed project is archived, reopened and verified with its tasks, results, reviews and history intact. |
| PROJ-006 | MVP | Closing a browser tab must not cancel work, complete a project or archive it. | Browser close/reconnect produces no task command and work continues according to server state. |
| PROJ-007 | MVP | Configure display name, template, enabled modules, limits, timezone, review policy and eligible capabilities without source edits. | Two-config acceptance demonstrates different settings and isolated data with one artifact. |
| PROJ-008 | Next | Allow reviewed extensions and project packs to add specialized views and workflows without changing core authority. | Versioned extension conformance rejects hidden permissions and incompatible versions. |
| PROJ-009 | Always | Keep public documents, examples, fixtures and handoffs generic; private project names, personal bot display names, machine labels and installation data stay in private configuration. | Public-source scan and fixture review contain none of the owner's private project, bot, machine or deployment names. |

## 3. Tasks, assignments and orchestration

| ID | Priority | Requirement | Acceptance evidence |
| --- | --- | --- | --- |
| WORK-001 | MVP | Create a task with title, instructions, expected deliverable, constraints, eligible capability, limits and review policy. | The saved canonical task returns the same bounded fields after restart. |
| WORK-002 | MVP | Support draft/propose/submit as distinct actions and never imply execution from a preview. | UI and service tests prove preview creates no queue or harness effect. |
| WORK-003 | MVP | Select an eligible worker automatically or allow an authorized manual choice. | Selection respects project, platform, capability, availability, capacity and current grants. |
| WORK-004 | MVP | Show proposed, queued, running, waiting for input, awaiting review, blocked, failed, uncertain, completed and accepted states. | Each state is produced from authoritative records and has a plain-English presentation. |
| WORK-005 | MVP | Allow eligible workers to discover and claim work without a separate human relay. | Concurrent claim test produces one accepted owner and deterministic refusals for the others. |
| WORK-006 | MVP | Permit a worker to hold multiple non-conflicting assignments within configured capacity. | Capacity tests admit independent work and refuse over-capacity or overlapping work. |
| WORK-007 | MVP | Release execution capacity while completed work waits for owner review. | Another eligible task starts while the first result remains awaiting review. |
| WORK-008 | MVP | Represent ownership, lease, scope and expiry so two workers do not unknowingly edit the same protected area. | Collision, expiry, renewal, handoff and stale-holder tests preserve exactly one current owner. |
| WORK-009 | MVP | Let a worker report a reproducible blocker and release or hand off work without marking it complete. | Handoff preserves evidence and makes the package claimable only after ownership safely ends. |
| WORK-010 | Always | Show platform, capability, difficulty, dependencies, allowed paths/effects and completion checks before claim. | A work packet missing any required field cannot become claimable. |
| WORK-011 | Always | Assign work by capability and platform rather than hardcoded personal bot names. | Generic worker registrations can satisfy the same packet without source edits. |
| WORK-012 | MVP | Allow a project to appoint a bounded lead/orchestrator that can divide and coordinate work within delegated limits. | Lead actions remain project-scoped, audited and unable to increase permissions or approve themselves. |
| WORK-013 | Always | Preserve owner authority over consequential actions even when a project lead is active. | Negative tests refuse self-granted effect approval, expanded budget and foreign-project control. |
| WORK-014 | MVP | Show a recommended worker, harness/model class, effort level and known cost/usage tradeoff before assignment while preserving the owner's final policy choice. | Selection explains its capability and limit basis; unknown price or usage remains unknown and a recommendation grants no authority. |
| WORK-015 | Always | Version reusable worker/reviewer skills and bind any required procedure to the work packet without treating the skill as permission. | Workers can retrieve the exact procedure/version and stale or substituted skills fail compatibility checks. |

## 4. Results, reviews, files and recovery

| ID | Priority | Requirement | Acceptance evidence |
| --- | --- | --- | --- |
| RES-001 | MVP | Return each result to the originating project, task and exact execution attempt. | Cross-project, stale-attempt and substituted-identity results are refused. |
| RES-002 | MVP | Retain bounded text, files, evidence, timestamps, usage truth and provenance. | Oversized, secret-shaped, path-based or unbound outputs fail safely without losing the canonical task. |
| RES-003 | MVP | Let the owner accept, reject or request revision and retain review history. | Browser and restart tests preserve the review and requested revision lineage. |
| RES-004 | MVP | A revision must create an explicit related work item, not mutate or silently rerun the accepted attempt. | Original and revised attempts remain visible and digest-bound. |
| RES-005 | Always | Separate quality review from approval for publication, installation, spending or production change. | Accepting a result grants no effect authority; a separate current approval is required. |
| RES-006 | MVP | Provide protected, bounded file download or preview with project/task/run provenance. | Anonymous, wrong-project, expired, oversized and arbitrary-path requests are refused. |
| RES-007 | Next | Support approved upstream remote artifact-return transports, including Hermes SSH or sandbox return where qualified. | Exact transport/version tests return one bounded artifact and cover disconnect, duplicate and cleanup behavior. |
| RES-008 | MVP | Reconcile lost replies and restarts before issuing another execution. | Lost-request and lost-response tests distinguish whether the server recorded the command and never duplicate uncertain work. |
| RES-009 | MVP | Recover in-progress identity and result state after browser, node or server reconnect. | Restart journey rejoins the same task/attempt and preserves capacity and review state. |
| RES-010 | Always | Unsupported cancellation, resume, usage or artifact behavior must be explicit and fail closed. | Capability drift and unsupported-operation tests emit unavailable states and no hidden command. |

## 5. Harnesses, nodes and machine connectivity

| ID | Priority | Requirement | Acceptance evidence |
| --- | --- | --- | --- |
| CONN-001 | MVP | Qualify Hermes Agent and Codex as the first two different harness integrations. | One versioned release completes the common task/result/review/revision journey with both at documented versions. The selected single-computer product path must not fork these shared services. |
| CONN-002 | MVP for This computer | Add Claude Code through the same shared adapter contract and conformance suite. | Claude-specific behavior is isolated in its adapter; common services require no Claude-only fork. A complete single-computer installation includes Hermes, Claude and Codex at their honestly qualified capabilities. |
| CONN-003 | Later | Allow OpenClaw and other harness adapters through a public extension contract. | A reference adapter passes conformance without gaining undeclared permissions. |
| CONN-004 | MVP | Register workers by stable node, harness, version, platform, capabilities and credential identity. | Duplicate, foreign, stale and version-drift registrations fail or downgrade honestly. |
| CONN-005 | MVP | Let macOS, Windows and Linux machines run their own connectors and credentials. | Published support matrix matches platform-specific install and conformance evidence. |
| CONN-006 | Always | Never copy provider credentials, live checkouts, node modules or agent state between machines. | Setup and update procedures use separate clones/installations and least-privilege secrets. |
| CONN-007 | MVP | Use authenticated outbound node connections; do not require public inbound worker ports. | Node enrollment/reconnect works through the approved private route and direct unauthenticated access fails. |
| CONN-008 | Always | Direct SSH or agent-to-agent messaging cannot become the task authority. | Any such transport is bounded behind a connector and canonical server admission remains required. |
| CONN-009 | Next | Expose compatible Control Room actions through MCP using the same services and permissions. | Website and MCP calls produce the same canonical records and authorization outcomes. |
| CONN-010 | Always | Publish exact support by harness version, OS and capability; architecture alone is not compatibility. | Support matrix links each positive claim to matching live or installed evidence. |
| CONN-011 | MVP | Allow browser and contributor use from macOS even when local Codex execution remains unsupported. | UI/setup works on macOS and the local Codex start path refuses safely until separately qualified. The local product may promote macOS Codex only after its separately documented custody qualification; no setup screen may bypass this gate. |
| CONN-012 | Always | Do not modify an installed harness to satisfy Control Room. | Adapter qualification uses supported upstream interfaces or records the feature unsupported. |

## 6. Idea Lab and news/research

| ID | Priority | Requirement | Acceptance evidence |
| --- | --- | --- | --- |
| IDEA-001 | Next | Start a bounded multi-agent idea discussion with selected eligible participants. | Real participants receive scoped prompts under explicit round, time, usage and cost limits. |
| IDEA-002 | Next | Retain distinct contributions, disagreements, partial failures and missing participants. | Synthesis cannot erase source contributions or claim absent responses. |
| IDEA-003 | Next | Let the owner compare, follow up, synthesize and record a decision. | Every action is explicit, reviewable and linked to the original discussion. |
| IDEA-004 | Next | Promote an approved idea into a normal project page with a proposed first task. | Promotion preserves provenance and creates no agent execution until separately submitted. |
| IDEA-005 | Next | Integrate supported Hermes Bot Mode profiles, rooms and routines without transferring Control Room authority. | Safe observations and participant work map to canonical project records; room messages alone cannot approve or dispatch. |
| NEWS-001 | Next | Provide configurable, authorized AI/technology news sources per project. | Source configuration is bounded, project-scoped and contains no secret in portable export. |
| NEWS-002 | Next | Reuse the selected Control Center discovery, ranking, freshness and reading modules. | Integration tests compare retained behavior with the pinned upstream tests and preserve attribution. |
| NEWS-003 | Next | Support important, newest, oldest, recent, history and archive views with source evidence. | Multi-page database results match upstream ranking/freshness and retain prior versions. |
| NEWS-004 | Next | Let the owner archive and restore stories without changing source evidence. | Recollection does not resurrect archived items or alter retained digests. |
| NEWS-005 | Next | Offer Research, Compare, Write setup guide and Draft actions from an article into a selected project. | Each action creates a reviewable proposed task using the common task path. |
| NEWS-006 | Next | Allow verification-first research on unverified articles while preserving the unverified label and evidence. | Research instructions require primary sources and uncertainty; other effects remain refused. |
| NEWS-007 | Always | Article actions must not automatically publish, install software, perform remote setup or contact a provider. | Click and task-preparation tests show zero external effects before separate authorization. |
| NEWS-008 | Always | News uses the common PostgreSQL, pg-boss lifecycle, workers, results and reviews. | No process timer scheduler, SQLite authority or parallel task system is introduced. |

## 7. Web, mobile, accessibility and voice

| ID | Priority | Requirement | Acceptance evidence |
| --- | --- | --- | --- |
| WEB-001 | MVP | Provide global Home, Projects, Workers, Needs attention and Settings navigation. | Each route opens from keyboard and deep link and displays authoritative data. |
| WEB-002 | MVP | Show running work, attention, blocked/offline workers, recent results and project links on Home. | Unknown or unavailable data is labeled, never converted to zero or healthy. |
| WEB-003 | MVP | Provide plain-English loading, empty, denied, missing, offline, error and uncertain states with safe next actions. | State-specific browser tests confirm preserved drafts and correct actions. |
| WEB-004 | MVP | Preserve route scope through reload, back/forward and late responses. | Two-project browser journey proves no stale screen overwrite. |
| WEB-005 | MVP | Keep core actions usable at 360-pixel width without page-wide horizontal scrolling. | Real compiled pages pass narrow-screen screenshots and interaction tests. |
| WEB-006 | MVP | Support keyboard creation, navigation, review and revision with visible focus and labeled controls. | Browser acceptance plus human assistive-technology review covers the complete core journey. |
| WEB-007 | MVP | Render untrusted output safely and identify external links. | Script, raw HTML, unsafe URL and agent-generated download tests fail safely. |
| WEB-008 | MVP | Make re-check, retry, cancel, archive, complete and review actions visibly distinct. | User-journey tests prove no command is emitted by a read-only action. |
| WEB-009 | Next | Add optional voice input and read-aloud through the same task/approval path. | Voice transcript is reviewable before submission and grants no extra authority. |
| WEB-010 | Always | Hide optional modules or label them unavailable until real backing services exist. | Production configuration cannot display synthetic activity as live. |

## 8. Data, storage and security

| ID | Priority | Requirement | Acceptance evidence |
| --- | --- | --- | --- |
| DATA-001 | MVP | Use one PostgreSQL primary as the sole global write authority. | Production composition contains one authoritative database path; competing writers/stores are refused. |
| DATA-002 | MVP | Provision a dedicated Control Room database with separate owner/migrator and restricted application roles. | Disposable PostgreSQL rehearsal proves role ownership, grants, migrations and restricted-login denial. |
| DATA-003 | Always | Keep the product PostgreSQL-provider neutral. The owner's reference deployment uses a private VPS PostgreSQL service and must not provision AWS RDS. | Generic operator configuration accepts a standard private PostgreSQL endpoint without requiring AWS-specific services. |
| DATA-004 | Always | Use PGlite only for local development and disposable tests. | Production startup refuses PGlite configuration. |
| DATA-005 | MVP | Use R2 or compatible object storage for bounded artifacts and verified backups, not coordination state. | Queue/lock/task writes never use object storage; artifact tests retain provenance and limits. |
| DATA-006 | Always | Scope every important record to tenant, project, task and exact operation as applicable. | Foreign-scope substitution and replay tests fail closed. |
| DATA-007 | Always | Store no credential, private key, raw host identity or unrestricted private prompt in public source or logs. | Public scan, structured redaction tests and reviewer inspection pass. |
| DATA-008 | MVP | Make important mutations replay-safe, auditable and recoverable after uncertainty. | Duplicate, stale, lost-reply and restart tests preserve one canonical outcome. |
| SEC-001 | MVP | Support a fixed server-selected signed-gateway login profile. The owner's reference deployment uses Cloudflare Access, exact-owner policy and authenticator-app MFA. Trusted personal devices should support the approved roughly one-week remembered session instead of repeated eight-hour codes; shorter upstream or untrusted-device rules still win. | The generic signed profile passes denial/expiry tests, and the reference deployment verifies real owner login, MFA, remembered session, logout and revocation. |
| SEC-002 | MVP | Bind the application to exact configured private hostnames. The owner's reference deployment uses one owner-selected hostname that stays out of public documentation and links. | Public source/site scan finds no owner-private address; exact-host checks reject aliases. |
| SEC-003 | MVP | Keep the origin non-public and reachable only through approved loopback/private routing and authenticated ingress. The reference deployment uses Cloudflare Tunnel. | Direct-origin probes fail while authenticated configured ingress succeeds. |
| SEC-004 | MVP | Separate browser identity/routes from machine connector identity/routes. | A node credential cannot use owner routes and an owner session cannot impersonate a node. |
| SEC-005 | Always | Treat obscurity only as an extra privacy layer, never authentication. | Guessed-host requests still require exact origin, Access assertion and local authorization. |
| SEC-006 | Always | Require separate current approval for consequential effects. | Expired, foreign, reused, inferred and self-issued approvals are refused. |
| SEC-007 | Always | Render and log only bounded sanitized evidence. | Secret-shaped values, full private payloads and usable internal locators are rejected or redacted. |

## 9. Installation, operation, updates and recovery

| ID | Priority | Requirement | Acceptance evidence |
| --- | --- | --- | --- |
| OPS-001 | MVP | Produce a versioned, integrity-checked Linux release installable without source edits. | Fresh-machine procedure installs the exact artifact using documented non-secret configuration. |
| OPS-002 | MVP | Run under a dedicated unprivileged service account and persistent supervisor. | Reboot/restart acceptance proves service ownership, intended listener and no root runtime. |
| OPS-003 | MVP | Coexist with unrelated websites and services on a modest server. | Resource and port acceptance shows no collision or disruption before and after install/update. |
| OPS-004 | MVP | Provide staged update, drain, restart, health check and rollback/refusal behavior. | Failed and successful update rehearsals preserve work and return to the recorded release. |
| OPS-005 | MVP | Let browsers and workers reconnect after normal updates without everyone closing manually. | Connections recover to canonical state and uncertain work is reconciled, not repeated. |
| OPS-006 | MVP | Provide migration preparation, application and recovery rules. | Schema version, exact candidate and rollback/refusal checks run before service cutover. |
| OPS-007 | MVP | Verify PostgreSQL backup by restoring into a disposable database. | Restore proves required rows, ownership, access controls and restricted-login behavior. |
| OPS-008 | MVP | Verify artifact backup/restore separately from database recovery and release rollback. | Each operation has its own identity, receipt, bounds and failure behavior. |
| OPS-009 | Always | Apply CPU, memory, concurrency, file, time, request and queue limits appropriate to the host. | Resource-pressure tests preserve system availability and do not exhaust the server. |
| OPS-010 | MVP | Show health, stale/offline workers, queue backlog, failures, uncertainty and resource pressure. | Operator view distinguishes missing data from healthy state and links to safe action. |
| OPS-011 | Next | Notify the owner about important completions, failures or decisions without routine noise. | Notification policy stays quiet on unchanged healthy state and cannot act as approval. |
| OPS-012 | Always | Do not require Tailscale or another single paid private-network vendor. | Documented node route supports standard authenticated HTTPS/private-network alternatives. |
| OPS-013 | Later | Provide optional bounded read-only session or terminal observation without turning it into a command, task or approval path. | Observation is explicitly stale/unknown when appropriate, omits sensitive content and cannot mutate canonical work. |
| OPS-014 | Next | Present worker capacity, model/effort choices, cost/usage history and resource bottlenecks when authoritative data exists. | Missing measurements remain unavailable; projections link to exact source records and cannot authorize scheduling by themselves. |

## 10. Public project, contribution and licensing

| ID | Priority | Requirement | Acceptance evidence |
| --- | --- | --- | --- |
| PUB-001 | Always | Publish the generic product under Apache License 2.0 with project NOTICE and attribution. | Release archive contains LICENSE, NOTICE and accurate source attribution. |
| PUB-002 | Always | Preserve every borrowed component's compatible license and required notices. | Shipped dependency/source inventory reconciles to the exact release contents. |
| PUB-003 | MVP | Keep `agentcontrolroom.xyz` as the public informational site with repository, contribution, maintainer, project-contact and `agenticbotsitter.com` links—but no private application link. | Deployed public-site review confirms the public links and finds no private application address or data. |
| PUB-004 | Always | Make the repository front page sufficient to understand the product, setup, current status, roadmap and contribution path. | A clean-room contributor can find and begin eligible work without private files or owner relay. |
| PUB-005 | Always | Maintain a live role/platform/difficulty-based work queue with substantial non-overlapping packages. | Ready, working, review, waiting, paused and done states match current issue evidence. |
| PUB-006 | Always | Automatically serialize valid claims and avoid a separate maintainer approval bottleneck. | Concurrent public claims yield exactly one `CLAIM ACCEPTED` record and start permission. |
| PUB-007 | Always | Require proportional independent review for significant work and final maintainer integration. | Pull request records review scope, corrections, checks and final disposition; authors cannot self-merge. |
| PUB-008 | Always | Let contributors continue other independent assigned work while review waits. | Workflow rules and capacity enforcement allow non-conflicting concurrent assignments. |
| PUB-009 | Always | Prefer coherent batches over tiny procedural jobs, commits or scheduled CI runs. | Work packets name a user outcome; CI runs on meaningful contribution events. |
| PUB-010 | Always | Keep credentials, private installation evidence, private project names, personal bot display names and personal business data out of public product content. | Current public source and release scans pass; private reporting uses a separate protected route. Historical GitHub authorship remains truthful contribution provenance. |

## 11. First-release end-to-end acceptance

The MVP cannot be declared complete unless one exact release candidate passes all of
the following as an integrated journey:

| ID | Required journey |
| --- | --- |
| MVP-001 | Install the exact public artifact on a private Linux host using documented configuration and a dedicated PostgreSQL database. |
| MVP-002 | Reach it only through protected browser access and complete a real owner MFA login from desktop and phone. |
| MVP-003 | Enroll and qualify at least one Hermes worker and one Codex worker at published versions and capabilities. |
| MVP-004 | Create two isolated projects and keep both open through deep links, reload and reconnect. |
| MVP-005 | Submit real work through the common queue, show honest progress and return the result and bounded files to the correct project. |
| MVP-006 | Review the result, request one revision and preserve both attempts and their evidence. |
| MVP-007 | Start another eligible task while the first waits for review, without exceeding worker capacity or colliding scopes. |
| MVP-008 | Inject a lost reply or disconnect and prove read-only reconciliation prevents duplicate execution. |
| MVP-009 | Restart and perform a staged update while preserving canonical work, worker reconnection and browser recovery. |
| MVP-010 | Restore verified database and artifact backups into disposable targets and validate ownership and access restrictions. |
| MVP-011 | Complete the core desktop, phone-width and keyboard journey with no project data leak, fake activity or unsafe output rendering. |
| MVP-012 | Publish the exact support matrix, license/notice inventory, known limitations, rollback instructions and retained acceptance evidence. |

### This-computer completion journey

The local installation choice is not a substitute for the release journey above.
It is the same product running one controller and its workers on one computer.
Before it is described as fully functional, it must pass these additional
requirements with the exact selected installed versions:

| ID | Required journey |
| --- | --- |
| LOCAL-001 | Start one configured local application using the same PostgreSQL database, pg-boss scheduler, project/task/result/review services and protected artifact path as the several-computer product. |
| LOCAL-002 | Show Hermes Agent, Claude Code and Codex separately in the protected browser, including their actual available and unavailable capabilities. A source-tested adapter is not shown as a running worker. |
| LOCAL-003 | Complete one bounded project task with each qualified harness through the same assignment, authority, delivery, result, review and linked-correction journey. |
| LOCAL-004 | For every enabled harness, prove denied work, cancellation or interruption, and restart recovery do not silently create another agent execution. Unsupported upstream capability remains visibly unavailable. |
| LOCAL-005 | Close/reopen the browser and restart the local controller while preserving saved projects, task state, staged terminal result evidence and the owner review record. |
| LOCAL-006 | Restore database and protected artifact bytes into disposable destinations before calling local backup/recovery verified. |
| LOCAL-007 | If the chosen local host is macOS, retain the existing Codex custody refusal until its two separate physical qualifications pass. A feature flag, configuration setting or browser button cannot bypass it. |

## 12. Traceability and change control

- `OWNER_PRODUCT_VISION.md` records the intended experience and product principles.
- This document defines required behavior and proof.
- `PUBLIC_BUILD_PLAN.md` and `WORK_QUEUE.md` sequence implementation and ownership.
- `COMPONENT_DECISIONS.md` records what is reused and any remaining qualification.
- `REUSE_DECISION_GATE.md` requires a recorded comparison before substantial
  custom infrastructure is added.
- `WEBPAGE_SPEC.md` gives detailed presentation behavior.
- `docs/SHARED_CONNECTOR_CONTRACT.md` and
  `docs/SECURITY_CONFIGURATION_CONTRACT.md` define shared technical and authority
  boundaries.
- `docs/SUPPORT_MATRIX.md` records what is actually supported now.

A change to architecture, permissions, data authority or the MVP journey must update
the affected requirement and its acceptance evidence. A pull request, passing unit
test or attractive screen does not silently remove a requirement.
