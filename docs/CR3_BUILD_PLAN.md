# CR-3 phased build plan

**Status:** Accepted; operator-workflow amendment accepted 2026-08-24; CR-5 implementation active
**Rule:** A phase authorizes only the changes named in that phase. Passing tests—not elapsed time—advances the build.

## Delivery strategy

Build thin vertical slices through production-shaped contracts. Synthetic adapters and disposable credentials come before live projects. Security, recovery, and observability tests arrive with the feature they protect rather than at the end.

GitHub is the **bootstrap coordination plane** while Control Room is being built. Codex/Sol owns architecture, integration, and acceptance. Hermes agents may implement bounded work packets on isolated branches; every returned pull request is tested and reviewed before merge. When CR-7 is operational, the same work-packet metadata becomes input to Control Room rather than being discarded.

## Phase map

| Phase | Outcome | Live external effects? |
|---|---|---|
| CR-3 | Accepted architecture and decision package | No |
| CR-4 | Secure core domain and persistence foundation | No |
| CR-5 | Enrolled synthetic node, evidence bundle, and durable cross-machine job slice | Disposable only |
| CR-6 | Fleet discovery, scheduling, workers, bottlenecks, services, and Action Inbox | Synthetic/local checks |
| CR-7 | Hermes and Codex adapters, normalized harness runs, procedure/knowledge registry, and northbound MCP | Bounded disposable tests |
| CR-8 | Claude, Completion Gate, approvals, review/revision, Telegram, and secrets | Bounded disposable tests |
| CR-9 | First project adapters: Content Blooms and Wayfarer | Separate per-project approval |
| CR-10 | Operational hardening and public-ready packaging | Deployment maintenance only |

## Model and reasoning assignment policy

The model is selected per **build block**, not once for the entire project. At the end of every block, the completion report names the exact model and reasoning effort for the next block so the owner can change the Codex setting before continuing.

Current baseline, based on [official OpenAI model guidance](https://developers.openai.com/api/docs/guides/latest-model) and the [current model catalog](https://developers.openai.com/api/docs/models):

- `gpt-5.6-sol`: frontier choice for architecture, security, concurrency, data integrity, protocol design, and difficult reviews;
- `gpt-5.6-terra`: balanced choice for ordinary implementation, adapters, platform packaging, UI, and test expansion;
- `gpt-5.6-luna`: efficient choice for bounded mechanical work whose correctness is determined by existing schemas/tests.

Reasoning-effort intent:

- `medium`: clear, bounded implementation with strong existing contracts and deterministic tests;
- `high`: multi-file production implementation or integration requiring careful diagnosis;
- `xhigh`: security-sensitive, concurrency-sensitive, migration-sensitive, or architecture-defining work;
- `max`: rare independent quality gate where missing a failure mode could cause security compromise, data loss, or unsafe public release.

Do not use `max` simply because a block is large. Split oversized blocks first. Model names and availability may change during this long build, so the recommendation is revalidated against official OpenAI documentation at the start of each phase. A model substitution is reported explicitly rather than silently changing the plan.

### Local and external model qualification

Do not infer that a local model is equivalent to Luna, Terra, or Sol from parameter count, benchmark reputation, or a successful demonstration. Each `(harness, model, machine, toolchain)` route begins as `provisional` and runs a repository-specific qualification pack covering:

1. schema-to-type implementation;
2. deterministic fixture and test generation;
3. bounded bug repair;
4. UI implementation from an accepted specification;
5. adapter mapping against recorded fixtures;
6. documentation and packaging maintenance.

Score compilation/test success, contract correctness, security-rule violations, unnecessary patch size, human review time, and rework rate. Promotion is task-class-specific:

- `mechanical`: documentation, fixtures, formatting, inventories, and exact-schema transforms;
- `bounded_implementation`: ordinary code under settled contracts and explicit allowed paths;
- `integration_candidate`: foreign-interface work using pinned fixtures, always with elevated review;
- `architecture_security`: never granted automatically; these decisions remain Sol-owned in the initial build.

Marvin's Qwen 3.8 27B route is therefore a strong candidate for early qualification, not pre-declared Terra/Luna-equivalent capacity. Qualification results later become ordinary Control Room capability evidence.

### Delegation classes by build block

| Blocks | Hermes/local contribution | Codex/Sol retained responsibility |
|---|---|---|
| CR-4A–CR-4C | Fixtures, negative-test tables, documentation, generated types after schemas settle | State machines, concurrency semantics, identity, authorization, approval and redaction design |
| CR-4D | Most contract-driven implementation and tests | Audit/security review and final integration |
| CR-5A–CR-5C | Protocol fixtures, portability helpers, reconnect tests | Protocol, enrollment, authentication and node policy ceilings |
| CR-5D | Synthetic executor, evidence-bundle foundation, artifact UI, deterministic tests | Vertical-slice acceptance and threat review |
| CR-6A–CR-6B | Native-machine probes, service packaging, telemetry and benchmark implementations | Capability semantics, trust levels and cross-platform acceptance |
| CR-6C | Simulation cases, property-test generators and analysis fixtures | Scheduler/fairness algorithm and safety invariants |
| CR-6D–CR-6E | Services, schedules, Action Inbox/Owner Focus, dashboard components, accessibility tests | Domain integration and owner-facing acceptance |
| CR-7A | Hermes lifecycle recordings, pinned fixtures and bounded adapter code | Hermes authority mapping and adapter acceptance |
| CR-7B–CR-7C | Test fixtures and client examples | Codex lifecycle, sandbox semantics and northbound MCP authority |
| CR-7D | SDK extraction, examples and conformance implementations | Public contract review |
| CR-7E | Procedure/knowledge fixtures, compatibility cases, and registry UI | Procedure promotion, trust, authority separation, and lifecycle semantics |
| CR-8A | Recorded Claude fixtures after authenticated discovery | Claude authority and lifecycle mapping |
| CR-8B | Test cases and non-authoritative UI fixtures | Separate approval, review, verification, revision, and consequential-action policy |
| CR-8C–CR-8D | Completion Gate UI, evidence previews, Telegram presentation, callback fixtures | Review independence, approval binding, webhook security and final integration |
| CR-8E | Provider fixtures and documentation only | Secret-broker interfaces, least privilege and canary review |
| CR-9 | Project fixtures, ordinary adapters, media workflow components | Source-authority preservation, live rehearsal and rollback acceptance |
| CR-10 | Packaging, docs, inventories, clean-room tests and platform runbooks | Release security, deployment recovery and final public gate |

Every delegated issue uses the work-packet template, names allowed paths, and has one accountable worker. Workers never share a branch or working directory. A pull request is a proposed result, not evidence that a block is complete.

### Review policy for delegated work

1. Run deterministic checks before semantic review.
2. Compare the patch only with its accepted contract and allowed paths.
3. Review state, authorization, data exposure, dependency, migration, and rollback impact.
4. Reproduce the worker's claimed validation independently where practical.
5. Request a focused repair when needed; do not silently rebuild an otherwise salvageable contribution.
6. Merge only after Codex/Sol records `accepted`, `accepted_with_followup`, or `rejected` and the owner-required gate is satisfied.

Use Sol `high` for normal delegated-code review and Sol `xhigh` for security-, concurrency-, migration-, protocol-, or live-integration-sensitive review. The `Q` blocks retain their existing `max` recommendation.

### Working-time estimate

These are planning ranges, not promises. They assume one Codex/Sol owner, one or two qualified Hermes lanes, prompt owner responses, and no live-provider surprises.

| Milestone | Sequential focused engineering days | With qualified parallel Hermes lanes | Likely calendar range at sustained part-time operation |
|---|---:|---:|---:|
| CR-4 secure core | 12–18 | 9–14 | 2–4 weeks |
| CR-5 synthetic cross-machine slice | 12–18 | 9–14 | 2–4 weeks |
| CR-6 fleet and dashboard | 15–24 | 10–17 | 3–5 weeks |
| CR-7 Hermes/Codex/MCP/procedure registry | 15–24 | 11–18 | 3–5 weeks |
| CR-8 Completion Gate/approvals/Telegram/secrets | 18–28 | 13–21 | 3–6 weeks |
| First CR-9 project integration | 10–20 | 8–15 | 2–4 weeks |

The first genuinely useful private system is the CR-5 vertical slice, roughly **4–8 calendar weeks** under these assumptions. A useful multi-harness system through CR-7 is roughly **8–14 weeks**. The first bounded live project integration is more realistically **12–22 weeks**. Parallel workers reduce implementation time, but architecture, review, physical-machine validation, and owner approvals remain serial bottlenecks. Actual throughput data replaces these ranges after the first three delegated pull requests.

### Block execution matrix

| Block | Scope/output | Recommended model | Effort | Why this level | Completion gate |
|---|---|---|---|---|---|
| CR-3-R | Final owner review of this architecture package | `gpt-5.6-sol` | `high` | Broad consistency and trade-off review | Owner accepts or records requested architecture changes |
| CR-4A | Canonical domain contracts and state machines | `gpt-5.6-sol` | `xhigh` | These contracts constrain every later module | Schemas/types, transition tables, contract tests pass |
| CR-4B | PostgreSQL migrations, repositories, leases, inbox/outbox, idempotency | `gpt-5.6-sol` | `xhigh` | Concurrency and data-loss risk | Concurrent claims, restart, duplicate-delivery, migration tests pass |
| CR-4C | Identity, authorization, policy, approval primitives, redaction | `gpt-5.6-sol` | `xhigh` | Security boundary and privilege design | Forgery, scope, child-authority, redaction, cross-tenant tests pass |
| CR-4D | Audit chain, configuration validation, operational errors | `gpt-5.6-terra` | `high` | Multi-file implementation under settled contracts | Tamper detection, fail-closed config, safe-error tests pass |
| CR-4Q | Independent CR-4 security/data-integrity review | `gpt-5.6-sol` | `max` | A missed flaw contaminates all later work | Findings resolved or explicitly accepted in decision log |
| CR-5A | Node protocol schemas, version negotiation, enrollment, authentication | `gpt-5.6-sol` | `xhigh` | Public protocol and device-identity boundary | Replay, expiry, revocation, malformed-frame tests pass |
| CR-5B | Portable bridge core, connection loop, heartbeat, local journal | `gpt-5.6-terra` | `high` | Substantial implementation with defined protocol | Reconnect/backpressure/journal recovery tests pass |
| CR-5C | Node-local policy ceilings, key-store interface, job/effect enforcement | `gpt-5.6-sol` | `xhigh` | Contains a compromised server and agent | Over-authority and ambiguous-effect tests fail safely |
| CR-5D | Synthetic executor, artifact/evidence flow, initial worker UI | `gpt-5.6-terra` | `high` | Full vertical slice with moderate UI work | Synthetic cross-machine job completes with audit, evidence claims, and artifact verification |
| CR-5Q | Crash, restore, adversarial protocol, and secret-canary review | `gpt-5.6-sol` | `max` | First real end-to-end security/durability gate | Clean restore/reconcile and attack suite pass |
| CR-6A | macOS, Windows, and Linux service packaging | `gpt-5.6-terra` | `high` | Platform-specific implementation and diagnostics | Start/restart/cancel/sleep/reboot checks pass per OS |
| CR-6B | Discovery, telemetry, capability probes, benchmarks | `gpt-5.6-terra` | `high` | Many deterministic integrations and schemas | Change detection, expiration, resource-threshold tests pass |
| CR-6C | Cross-project scheduler, fairness, semaphores, bottlenecks | `gpt-5.6-sol` | `xhigh` | Algorithmic correctness and starvation/resource risk | Simulation/property tests and evidence explanations pass |
| CR-6D | Services, schedules, incidents, reconciliation | `gpt-5.6-terra` | `high` | Stateful but contract-driven feature work | Recurrence, deduplication, incident and recovery tests pass |
| CR-6E | Portfolio/project/worker/bottleneck dashboard plus Action Inbox and Owner Focus | `gpt-5.6-terra` | `high` | Balanced implementation plus frontend judgment | Attention reason/action/blocking, responsive/accessibility/render tests, and owner review pass |
| CR-6Q | Fleet/scheduler architecture review | `gpt-5.6-sol` | `xhigh` | Checks policy bypass, starvation, and platform drift | Findings closed and acceptance matrix complete |
| CR-7A | Hermes execution/read adapter and fixtures | `gpt-5.6-sol` | `high` | Large, version-sensitive foreign interface | Canonical lifecycle suite and pinned fixtures pass |
| CR-7B | Codex worker adapter, normalized harness run, and worktree/result mapping | `gpt-5.6-sol` | `high` | Agentic coding lifecycle, safe event projection, and sandbox correctness | Start/stream/steer/cancel/resume/change/test/result/usage suite passes |
| CR-7C | Northbound Control Room MCP server | `gpt-5.6-sol` | `xhigh` | New agent-facing authority surface | Scope, approval, replay, redaction, and delegation tests pass |
| CR-7D | Adapter SDK and conformance-kit extraction | `gpt-5.6-terra` | `high` | Generalization after two real harness mappings | Hermes/Codex pass the same public conformance suite |
| CR-7E | Versioned procedure and knowledge registry | `gpt-5.6-sol` | `high` | Reusable agent instructions must remain distinct from facts, policy, and authority | Digest/provenance/compatibility/promotion/rollback tests pass; no package grants authority |
| CR-7Q | Harness/MCP security and compatibility review | `gpt-5.6-sol` | `xhigh` | Ensures harnesses cannot bypass core authority | Findings closed or adapters remain disabled |
| CR-8A | Authenticated Claude adapter | `gpt-5.6-sol` | `high` | Version-sensitive lifecycle integration | Authenticated lifecycle and usage/worktree tests pass |
| CR-8B | Separate approval, review, verification, finding, and revision domain/backend | `gpt-5.6-sol` | `xhigh` | Quality decisions and consequential authorization must not be conflated | Operation-binding plus review-target, independence, bounded-revision, supersession, expiry, replay, and step-up tests pass |
| CR-8C | Completion Gate UI and evidence/media/diff preview surfaces | `gpt-5.6-terra` | `high` | Frontend, evidence interpretation, and correction interaction | Mobile/accessibility/claim-to-evidence/annotated-change/decision-lineage tests pass |
| CR-8D | Telegram notification and action adapter | `gpt-5.6-terra` | `high` | External callbacks with bounded authority | Signature/allowlist/idempotency/quiet-hour/risk tests pass |
| CR-8E | Bitwarden and 1Password node-local brokers | `gpt-5.6-sol` | `xhigh` | Secret-exposure and privilege risk | Secret canary, scope, rotate/revoke/failure tests pass |
| CR-8Q | Approval/review/secrets adversarial review | `gpt-5.6-sol` | `max` | Last gate before project credentials | No central plaintext path, approval bypass, self-review acceptance, or AI risk downgrade remains |
| CR-9A | Content Blooms source-scheduled adapter | `gpt-5.6-sol` | `high` | Must preserve foreign lease/authority semantics | Read-only then bounded command receipts pass |
| CR-9B | Lo-Fi Wayfarer project pack and media workflow | `gpt-5.6-terra` | `high` | Larger domain implementation under settled core | Synthetic media/QC/review/assembly flow passes |
| CR-9C | First bounded live integration rehearsal | `gpt-5.6-sol` | `xhigh` | Cross-system rollback and production-risk review | Owner-approved rehearsal, rollback, and audit pass |
| CR-9D | Shared Project Workspace and ABS AI/tech news project | `gpt-5.6-terra` | `high` | Owner-facing information queues and broad effect-free implementation under the Sol-frozen contract | Fake collection, dedupe, proposal editor, accessibility, and no-dispatch tests pass |
| CR-10A | Deployment, backups/PITR, updates, monitoring, runbooks | `gpt-5.6-sol` | `high` | Operations and recovery correctness | Clean-host restore, canary upgrade, incident drill pass |
| CR-10B | Public SDK/package/docs/examples | `gpt-5.6-terra` | `high` | Broad packaging and developer experience work | Clean-room installation and adapter example pass |
| CR-10C | Mechanical SBOM, license inventory, fixture/docs normalization | `gpt-5.6-luna` | `medium` | Bounded high-volume work checked by deterministic tooling | Scans, links, schemas, formatting, and fixture tests pass |
| CR-10Q | Independent public-release security and privacy review | `gpt-5.6-sol` | `max` | Highest-impact release gate | Disclosure process, clean repo, threat tests, findings closure |

### Completion and next-block handoff

After every block, the build report uses this format:

```text
Completed: CR-5B — Portable node bridge core
Delivered: <main modules and contracts>
Validation: <tests/checks and results>
Open risks: <none or explicit items>
Decision-log changes: <ADR references or none>

Next block: CR-5C — Node-local policy and effect enforcement
Set model: gpt-5.6-sol
Set reasoning effort: xhigh
Why: security boundary against over-authorized or compromised dispatch
Inputs/approval needed: <none or exact owner action>
```

CR-5C's architect-frozen normative input is `docs/CR5C_FINAL_SECURITY_CONTRACT.md` with ADR-023 through ADR-030. Research reports remain supporting evidence. Implementation begins with CR-5C.1 canonical schemas and signed artifacts and must stop before persistence or executor wiring.

If a block does not pass its completion gate, it remains the current block. The report recommends the model/effort for the repair or review rather than advancing the phase prematurely.

## CR-3 — Architecture approval

### Deliverables

- consolidated architecture;
- security and trust architecture;
- data, backup, and recovery design;
- protocols and extension contracts;
- decision log;
- phased backlog and acceptance matrix.

### Exit criteria

- owner accepts central topology, security posture, and recovery model;
- unresolved decisions are explicitly deferred with triggers;
- no contradiction with CR-0 through CR-2 authority/redaction rules;
- Content Blooms, Wayfarer, short requests, and future harnesses fit without bespoke core changes.

## CR-4 — Secure core domain and persistence

### Build

1. Add versioned contracts for request, workflow, job, attempt, lease, checkpoint, effect intent, approval, service, schedule, incident, artifact manifest, node, and message envelope.
2. Add forward PostgreSQL migrations and repositories.
3. Implement transactional state-transition functions rather than scattered table writes.
4. Add inbox/outbox and idempotency infrastructure.
5. Add application identity/role/policy interfaces and safe single-owner bootstrap.
6. Add strict redaction and safe-error libraries at persistence/transport boundaries.
7. Add audit hash chaining and external-anchor interface.
8. Add configuration validation and production-safe defaults.

### Tests

- migration and rollback/recovery rehearsal on disposable database;
- state-machine transition/property tests;
- concurrent lease claim/reclaim;
- approval survival across restart;
- inbox/outbox duplicate delivery;
- cross-scope authorization;
- forbidden secret/private-content canaries;
- audit append-only and hash validation;
- public endpoint inventory snapshot.

### Stop condition

No real node enrollment or production Cloudflare/PostgreSQL change without a CR-5 deployment approval.

## CR-5 — Synthetic node vertical slice

### Build

1. Define node enrollment, challenge/response, version negotiation, heartbeat, job offer, lease, event, cancellation, and reconciliation schemas.
2. Implement the portable bridge core and one native Linux service package for a disposable environment.
3. Implement local key store abstraction, local policy ceiling, SQLite journal, redacted event spool, and retry/backoff.
4. Implement a synthetic typed executor that sleeps, checkpoints, produces a text artifact manifest plus claim-bound verification evidence, accepts cancellation, and can simulate crashes.
5. Add node/worker dashboard pages, an initial evidence view, and quarantine/drain controls.
6. Deploy a disposable Control Room/PostgreSQL/tunnel environment or isolated namespace.

### Security tests

- expired/reused enrollment token;
- forged node signature;
- replayed/expired message;
- revoked/quarantined node;
- job beyond local ceiling;
- child authority expansion;
- oversized/malformed frames and connection-rate limits;
- server loss/reconnect reconciliation;
- secret canary remains absent everywhere.

### Durability tests

- kill node during each job state;
- kill app and PostgreSQL process;
- restore from backup and reconcile node journal;
- ambiguous effect creates attention instead of duplicate action.

### Exit criteria

One synthetic job travels dashboard/API → PostgreSQL → remote node → artifact/evidence bundle → review/result with complete audit and restart recovery. The slice proves that an artifact locator and a verification claim are distinct.

## CR-6 — Fleet, scheduler, services, and bottlenecks

### Build

1. macOS launchd and Windows Service packages, with Linux systemd retained.
2. Static/dynamic discovery and change fingerprints.
3. Harness/tool inventory manifests.
4. Versioned capability probes and benchmarks.
5. CPU/GPU/RAM/storage/network capacity and scratch thresholds.
6. Multi-project allocation, fair-share debt, priority, cost, privacy, deadline, and maintenance policies.
7. GPU/exclusive-resource semaphores and availability windows.
8. Bottleneck calculations and evidence-backed recommendations.
9. Continuous service, schedule, incident, and reconciliation models.
10. Portfolio/project/worker/history/capability/resource/bottleneck UI.
11. Universal Action Inbox for sessions/jobs waiting on input, review, approval, failure handling, ambiguity, incident response, or expiring authority.
12. Owner Focus pins (`P0`/`Today`) as a simple human priority projection above deterministic scheduler policy.

### Tests

- machine hardware or disk changes trigger rediscovery;
- low disk prevents unsafe claim and recommends offload;
- benchmark expiration removes or downgrades route eligibility;
- one project cannot starve every other project indefinitely;
- manual/exclusive/preferred/shared/opportunistic modes behave deterministically;
- service schedules do not flood the ordinary job board;
- offline nodes remain visible with reason/remedy.
- every attention item states the requested action, reason, blocked work, legal responses, age/expiry, evidence, and delivery status;
- owner focus changes priority intent without bypassing fairness, authority, or project allocation.

### Platform onboarding gates

- Mac: launchd restart, sleep/wake, process-tree cancel, key store, local harness inventory.
- Windows: service restart, Job Object cancellation, sleep/reboot, WSL2 boundary, RTX/NVENC probe, DPAPI/broker, scratch path.
- Johnny5: Docker/native discovery, systemd, cgroups/container availability, storage and backup impact.

## CR-7 — Hermes, Codex, and northbound MCP

### Hermes adapter

- pinned `tui_gateway` stdio lifecycle;
- versioned event fixtures;
- read-only `hermes serve` projection adapter;
- profile/session/usage/cron correlation;
- cancellation/reconnect behavior;
- protected native-dashboard links;
- optional thin Control Room context plugin, after core adapter.

### Codex adapter

- `codex exec --json` first conformance seam;
- isolated worktree/sandbox selection;
- thread, event, usage, file, test, patch/commit, cancel, and resume mapping;
- SDK comparison only after the wrapper passes.

### Normalized harness runs

- map every Hermes and Codex execution into a safe harness-run record beneath its attempt;
- retain opaque native session/thread ID, lifecycle state, timestamps, usage, structured tool/file/test activity, resumability, cancellation, and protected native link;
- preserve parent/child and fork/supersession lineage without importing raw transcripts or unrestricted command output by default;
- expose a session-watch projection showing running, waiting, blocked, failed, and ready-for-review work across projects;
- distinguish adapter transport retry from a new review-requested revision.

### Northbound MCP

- authenticated/scoped request, project, worker, job, attention, and artifact tools;
- a Codex task can propose/delegate work and later inspect results;
- MCP cannot issue secrets or bypass approvals.

### Procedure and knowledge registry

- procedures describe repeatable methods and acceptance steps;
- knowledge bundles carry project facts and reference context;
- policy and authority remain separate and cannot be granted by either package;
- packages have immutable versions, digests, provenance, trust state, compatibility declarations, and promotion/rollback history;
- run outcomes may propose package revisions, but activation requires the configured review gate;
- capability eligibility records which verified package versions a worker can execute.

### Exit criteria

- Hermes and Codex each pass the same canonical lifecycle suite or declare unsupported verbs;
- a Codex project task delegates a synthetic job through MCP and reviews the returned result;
- Session Watch reconstructs the safe state of both harnesses without treating either native UI as authority;
- one reviewed procedure revision is promoted while a rejected revision leaves the prior version active;
- no production repository/project mutation without separate approval.

## CR-8 — Claude, approval/review, Telegram, and secrets

### Claude adapter

- owner completes authenticated disposable setup;
- pinned stream-json lifecycle tests;
- permission/cancel/resume/usage/subagent/worktree mapping;
- SDK deferred unless a required capability is missing.

### Approval and review

- exact-operation approval digests;
- strong-factor step-up path for consequential actions;
- approval, review, verification, finding, revision, and preference are separate records and state machines;
- immutable review targets and acceptance profiles;
- review items with image/video/audio/diff/report previews and claim-bound evidence bundles;
- deterministic verification scenarios with pass/fail/blocked/inconclusive results;
- AI pre-review comments clearly attributed and non-authoritative;
- reviewer-independence constraints using author, worker, agent profile, harness, and model-family provenance;
- deterministic risk floors that AI scoring may raise but never lower;
- bounded request-changes/revise cycles with explicit finding resolution and supersession lineage;
- Completion Gate profiles for code, media, documents, and operational changes;
- automatic low-risk disposition only when deterministic policy explicitly permits it.

### Telegram

- verified webhook secret, chat allowlist, idempotent callbacks;
- quiet hours, urgency, grouping, destination preferences;
- low/medium-risk buttons;
- high-risk deep link to strong dashboard approval;
- expiry and replay tests.

### Secrets

- credential reference catalog;
- Bitwarden node broker first;
- 1Password broker conformance path;
- destination-native credential mode;
- redaction canary and rotation/revocation drills.

### Exit criteria

One disposable workflow can ask a question, request approval, receive a Telegram response where permitted, resolve a node-local scratch credential, produce claim-bound review evidence, pass through an independent bounded revision cycle, and complete without secret leakage or confusing quality acceptance with effect authorization.

## CR-9 — First real project integrations

Each project receives its own scope, credentials, rollback, fixtures, and approval. Connecting one does not authorize the other.

### Content Blooms first slice

- Begin read-only/source-scheduled.
- Project/transcription/work projections and capability routes.
- Placement request with source receipt, not direct lease takeover.
- Mac/Windows/VPS transcription comparison.
- One reviewable research/transcription/article handoff path.
- Existing source behavior remains reversible and independently operable.

### Lo-Fi Wayfarer first slice

- Begin with project pack and deterministic synthetic media.
- Model render segment, audio candidate, QC, review, assembly, and publish-preparation jobs.
- Exercise local/R2 artifact manifests and GPU/scratch scheduling.
- Add Unreal only after a measured scene/render benchmark exists.
- YouTube upload/publish remains separately approved and destination-idempotent.

### Exit criteria

Each project can be disabled independently. A failure or upgrade in one adapter cannot stop the other or the Control Room core.

## CR-10 — Operations and public-ready packaging

### Operations

- production Docker Compose and native systemd reference deployments;
- Cloudflare Tunnel/Access reference configuration without private values;
- PostgreSQL backups, WAL/PITR, restore automation, and quarterly drill;
- optional Uptime Kuma adapter after disposable proof;
- update canaries, rollback, service health, resource alerts;
- incident and break-glass runbooks;
- retention and privacy controls.

### Public packaging

- separate core, adapter SDK, conformance kit, reference adapters, and private deployment config;
- signed releases and reproducible build guidance;
- SBOM, licenses, NOTICE, vulnerability reporting, security policy, supported versions;
- example deployment contains synthetic identities/data only;
- documentation for creating a project pack, harness adapter, executor, provider adapter, and new node package.

### Public-release gate

- independent security review/threat-model pass;
- responsible disclosure process and private reporting channel;
- no internal hostnames, IDs, emails, credentials, artifacts, or production history;
- clean-room installation succeeds from public instructions;
- supported version and patch policy defined.

## Backlog sequencing rules

- No UI-only feature may imply authority the backend does not enforce.
- No adapter begins before its canonical contract and conformance tests exist.
- No secret provider begins before central plaintext retrieval is impossible by interface.
- No production effect begins before idempotency, audit, approval, and recovery behavior exist.
- No worker is called “verified” based only on hardware discovery.
- No research recommendation becomes a dependency without license and operational verification.
- Every phase updates the decision log when reality changes a trade-off.

## Owner decisions intentionally postponed

These are settings, not architecture blockers:

- exact hosted binding and any subdomains under the owner-reserved `agentcontrolroom.xyz` domain;
- exact quiet hours and notification routing;
- per-project budgets and approval thresholds;
- retention duration;
- which password manager is enabled first;
- Docker versus native deployment after Johnny5 discovery;
- when an optional standby or managed database is worth its cost;
- which project becomes the first live integration after synthetic proof.

The dashboard will expose configurable policy/preferences where safe; security invariants are not user-disableable convenience settings.

## CR-11 — Agent Team and project War Rooms

CR-11 adds the people-first collaboration layer after the project, schedule, worker, approval, evidence, and operations foundations exist.

### First slice

- Project-scoped Agent Team roster with evidence-backed presence and device-disambiguated handles.
- Reviewed role/model/package summaries without raw prompts, memory, native profile data, provider access, or private infrastructure values.
- Agent routines as non-authorizing schedule projections.
- Two-to-six-member War Rooms with fixed loop, duration, reasoning, and cost ceilings.
- `@mention` handoffs that stop as owner-review drafts before canonical work materialization.
- One consistent responsive Team surface across every Project Workspace.

### Exit criteria

- Team visibility cannot create a job, dispatch, approval, lease, command, or execution grant.
- Working state is impossible without current authenticated evidence and exact current work.
- Rooms fail closed on scope, membership, sequence, round, mention, loop, and digest drift.
- Authenticated local durable state stores safe summary events only, preserves on unconfigured retention, binds legal-hold hooks, verifies restart and rollback before use, and exposes no cleanup or effect executor.
- One exact authenticated owner decision may atomically materialize only non-runnable canonical proposed work plus its Action Inbox record; rejection and withdrawal create nothing, and no review grants approval or dispatch authority.
- Hermes Bot Mode calls remain absent until a separately pinned, read-only, conformance-tested adapter is accepted.
- `agentcontrolroom.xyz` remains an owner-held future deployment destination; no hosted effect occurs in CR11A.
## CR12B-IDEA-030 — protected Bot Mode coordinator and owner promotion

Status: complete locally for the repository-only, provider-disabled implementation. See
`CR12B_IDEA_030_ACCEPTANCE.md` and ADR-126.

The block adds exact provider-session evidence, an independently verified live-provider gate, serialized budgeted panel
orchestration, an append-only PostgreSQL run ledger, terminal post-marker ambiguity, and a protected human-owner-only
promotion permit and HTTP boundary. The default composition stays disabled and no native provider contact occurred.

Next: CR12B-IDEA-040 protects session creation and synthesis, then connects those safe operations to the Idea Lab UI.

## CR12B-IDEA-040 — protected Idea Lab operator workflow

Status: complete locally for the authenticated repository-fake, provider-disabled implementation. See
`CR12B_IDEA_040_ACCEPTANCE.md` and ADR-127.

The block adds a human-owner-authorized operator service and protected create, start, cancel, and synthesis routes. All
scope, identities, panel membership, provider evidence, and durable identifiers are server-derived. The Idea Lab page
has separate controls for each recorded step and for the existing save/promote decision, but the shipped composition
keeps every control disabled because no owner-session or live provider runtime is installed. The full workflow is proven
only with the zero-network repository fake.

Next: CR12B-IDEA-050 adds owner-scoped session discovery and reload-safe resume plus protected reversible project
lifecycle controls. Live provider contact remains a separate exact authorization and qualification gate.

## CR12B-IDEA-050 — durable session resume and protected project lifecycle

Status: complete locally for the owner-authenticated, repository-fake, runtime-disabled implementation. See
`CR12B_IDEA_050_ACCEPTANCE.md` and ADR-128.

The block adds effect-free owner-scoped session catalog/detail reads, stable durable projections, automatic browser
reload/resume, and human-owner-only pause, resume, complete, archive, and reopen commands. Reads create no policy writes.
Lifecycle commands are route-scoped, version-checked, replay-safe, and transactional. The visible controls expose only
legal transitions and remain disabled in the shipped composition.

Next: CR12B-IDEA-060 installs one explicit local non-production composition and runs one owner-attended repository-fake
pilot. It does not authorize live provider contact.

## CR12B-IDEA-060 — explicit local composition and owner-attended repository-fake pilot

Status: complete for the exact local, Keychain-backed, repository-fake owner pilot. See
`CR12B_IDEA_060_ACCEPTANCE.md`, `CR12B_IDEA_060_OWNER_PACKET.md`, and ADR-129.

The exact development-only composition uses a loopback foreground server, one-time 15-minute owner session, Keychain-held
master key with separate derived integrity domains, persistent local PGlite outside the repository, an authenticated
project catalog plus independent high-water, and only the deterministic repository-fake panel. Dynamic promoted-project
pages read protected local truth and expose legal owner lifecycle transitions. Production mode and every unconfigured run
remain closed. The exact development switch selects Vinext's Node runtime because PGlite is not a Cloudflare-worker
database; ordinary previews and every production build keep the Cloudflare plugin.

The owner-attended packet passed create, panel, synthesis, project promotion, protected project read, pause/resume,
reload, and real foreground restart persistence. No later block may treat this repository-fake acceptance as authority
for live Hermes/provider contact.

Next: CR12B-IDEA-070 defines the provider-neutral live-panel admission boundary, exact Hermes compatibility inputs, and
one separately authorized owner packet. Repository work remains provider-disabled and effect-free until that packet is
accepted.

## CR12B-IDEA-070 — provider-neutral live-panel admission and Hermes packet

Status: complete for the exact repository-only, provider-disabled snapshot. See `CR12B_IDEA_070_ACCEPTANCE.md`,
`CR12B_IDEA_070_OWNER_PACKET.md`, and ADR-130.

The accepted admission seam binds the coordinator to exact provider/runtime/compatibility/native-qualification and
protected-value-custody evidence, every participant/runtime identity, exact session ceilings, one single-use
strong-factor-backed owner window, serialized durable pre-call markers, terminal ambiguity/no retry, filtered
contributions, between-call cancellation, disabled steering, and reconciliation-only resume. Separate server-held
provider and admission authorities must agree. The disabled Hermes 0.21 packet pins exact source evidence but contains no
native receipt, owner window, accepted admission, or driver. Default, browser, local-pilot, and production composition
remain provider-disabled.

Next: CR12B-IDEA-080 implements the default-disabled filtered provider driver and disposable native-qualification
harness. Repository implementation remains effect-free; no native attempt occurs without a later exact owner window.

## CR12B-IDEA-080 — filtered provider driver and native qualification harness

Status: complete for the exact repository-only, injected-fixture, provider-disabled snapshot. See
`CR12B_IDEA_080_ACCEPTANCE.md`, `CR12B_IDEA_080_OWNER_PACKET.md`, and ADR-131.

The injected node-local driver rechecks exact admission/runtime/participant bindings, discards streaming content before
parsing, accepts one strict filtered completion or definite failure sequence, derives a cleanup-bound receipt, and makes
timeouts, malformed evidence, and cleanup uncertainty terminally ambiguous through the existing coordinator. The frozen
ten-stage qualification plan remains blocked with no native port, owner window, or accepted receipt. Its injected
simulation cannot claim native qualification. Every composition remains provider-disabled.

Next: CR12B-IDEA-090 implements authenticated durable single-use admission consumption and an exact accepted-native-
receipt registry. It remains repository-only and performs no native attempt.

## CR12B-IDEA-090 — durable admission consumption and native-receipt registry

Status: complete for the exact repository-only, provider-disabled snapshot. See `CR12B_IDEA_090_ACCEPTANCE.md`,
`CR12B_IDEA_090_OWNER_PACKET.md`, and ADR-132.

The PostgreSQL-compatible append-only authority ledger separates architect-authenticated native-receipt decisions,
server-authenticated admission decisions, and atomic consumption. It binds one admission/window/run, makes exact replay
inert, rejects cross-binding reuse, preserves terminal revocation, and detects database rollback through an external
authenticated high-water. It remains unconfigured in every shipped composition and performs no native/provider call.

Next: CR12B-IDEA-100 freezes the owner-ready native qualification and first-live-panel rehearsal packet without executing
it. The later native attempt and provider panel remain separate exact owner authorizations.

## CR12B-IDEA-100 — owner-ready native qualification and live-panel rehearsal packet

Status: complete for the exact repository-only, effect-free packet. See `CR12B_IDEA_100_ACCEPTANCE.md`,
`CR12B_IDEA_100_OWNER_AUTHORIZATION.md`, and ADR-133.

The immutable three-stage packet binds exact Hermes 0.21 source and implementation commits, a one-attempt/one-call
disposable qualification, an unaccepted sanitized candidate, mandatory different-party review and architect registry
acceptance, and a later separately authorized live-panel admission. Every authority field remains false. The local pilot
is repository-fake only.

Next: CR12B-IDEA-105 refreshes the Idea Lab packet from the upstream release revision to the exact reviewed installed
Hermes 0.21 runtime and binds the sanitized no-effect source preflight. It performs no native attempt.

## CR12B-IDEA-105 — Hermes 0.21 reviewed-runtime pin refresh

Status: complete locally for the repository-only evidence binding. See
`CR12B_IDEA_105_HERMES_021_PIN_REFRESH_ACCEPTANCE.md`, `CR12B_IDEA_105_OWNER_AUTHORIZATION.md`, and ADR-134.

The block distinguishes the upstream release commit from the exact installed runtime 60 reviewed commits later, binds
the accepted compatibility implementation plus twelve-source manifest and sanitized preflight digests, and carries the
new pin through the Idea Lab packet, qualification plan, live-evidence fixtures, and owner-ready candidate boundary. The
earlier authorization is non-reusable because the exact packet and plan digests changed. No native/provider contact or
protected-value access occurred.

Next: CR12B-IDEA-108 checks whether the reviewed Hermes profile operations can actually satisfy the disposable empty
profile plus existing-authentication boundary before any owner command is emitted.

## CR12B-IDEA-108 — Hermes native-launch readiness

Status: complete with a blocked-before-owner-command disposition. See
`CR12B_IDEA_108_NATIVE_LAUNCH_READINESS_ACCEPTANCE.md` and ADR-135.

Exact source inspection proves a fresh no-skills profile has an empty protected-value file, while clone imports the
protected-value file plus SOUL, skills, and memory and is mutually exclusive with no-skills. Hermes exposes no
protected-value-only clone. The digest-bound readiness contract therefore emits no command and grants no authority.

Next: CR12B-IDEA-109 freezes the Hermes-native profile preparation method required for the protected-value-only
remediation. It remains proposal-only and accepts no runtime.

## CR12B-IDEA-109 — Hermes-native profile preparation contract

Status: complete locally for the effect-free proposal-only boundary. See
`CR12B_IDEA_109_HERMES_PROFILE_PREPARATION_CONTRACT_ACCEPTANCE.md` and ADR-136.

The method contract transfers existing authentication inside Hermes custody, copies no private bot context, returns no
material or path, starts no gateway/provider, retains the one-use launch permit natively, and emits only signed digests
plus negative counts. Requests expire within 60 seconds and grant no command authority. The accepted-runtime list is
empty until an exact implementation is independently reviewed.

Next: CR12B-IDEA-109A adds canonical signed-attestation verification while keeping the runtime unaccepted.

## CR12B-IDEA-109A — signed profile-preparation attestation

Status: complete locally for injected signed evidence only. See
`CR12B_IDEA_109A_PROFILE_PREPARATION_ATTESTATION_ACCEPTANCE.md` and ADR-137.

The verifier binds canonical Ed25519 device identity, exact request/runtime/chronology, zero private-context counts,
negative material/path/gateway/provider truth, and cleanup presence. It returns only safe digests and never converts an
injected fixture into runtime acceptance or launch eligibility.

The later IDEA-109B source reassessment removes this optional upstream method from the critical path.

## CR12B-IDEA-109B — enrolled local/SSH Hermes connection

Status: complete locally for the signed, locator-free, connection-disabled snapshot. See
`CR12B_IDEA_109B_ENROLLED_HERMES_CONNECTION_ACCEPTANCE.md` and ADR-138.

Exact installed source proves that fresh no-skills profiles already use a read-only global-root protected-value fallback
without copying Bot context, and that Hermes already supplies key-only connect-on-demand SSH connections. Control Room
therefore verifies node-signed enrollments for an opaque fixed local/SSH gateway route, requires owner-verified SSH host
identity, retains no host/user/port/key/session/protected-value/profile locator, exposes no generic shell, and produces a
safe multi-machine roster. Enrollment qualifies only the route to enter IDEA-110; it grants no provider, command, lease,
approval, or execution authority.

The repository-owned policy port and durable spend boundary are implemented by IDEA-110A below. The platform bridge,
packet refresh, and separately authorized owner-attended qualification remain later gates.

## CR12B-IDEA-110A — enrolled qualification gateway and durable one-use spend

Status: complete locally for the repository-owned, provider-disabled policy port. See
`CR12B_IDEA_110A_ENROLLED_GATEWAY_PORT_ACCEPTANCE.md` and ADR-139.

The port accepts only a canonical Ed25519 owner window bound to one signed enrollment, opaque route, profile,
conversation, participant, effect marker, exact Hermes revision, and fixed method set. It atomically spends that permit
before an injected bridge can run, exposes no host or generic shell, and fixes tools/MCP/plugins/retry off. Migration
0032 and the PostgreSQL-compatible authenticated event store make claim, native return or ambiguity, and cleanup result
append-only, uniquely spent, restart-safe, and rollback-detecting through an external checkpoint. Repository tests use
PGlite; production remains one private PostgreSQL primary.

Next: implement and independently review the fixed local/SSH native bridge, obtain one real signed enrollment, refresh
the exact owner packet and pins, then request a new owner-attended IDEA-110 qualification window.

## CR12B-IDEA-110B — fixed Hermes local/SSH bridge

Status: accepted for the exact provider-disabled repository snapshot after two remediation rounds and a second different
independent re-review. Connector configuration and enrollment remain absent.
See `CR12B_IDEA_110B_FIXED_HERMES_BRIDGE_ACCEPTANCE.md` and ADR-140.

The repository bridge uses Hermes Desktop's already enrolled local or SSH route. An injected connector owns every
machine locator, key, gateway value, protected value, and native session identifier. Control Room sends only signed
opaque route/attempt/permit digests and the fixed create, prompt, replay, status, usage, interrupt, and close operations.
It rejects gateway-epoch changes, replay gaps or truncation, malformed terminal JSON, usage drift, extra native fields,
and uncertain outcomes without retry; cleanup is attempt-bound even when route opening was uncertain. The signed owner
window now binds participant identity and runtime identity, and the enrollment method set explicitly includes close.

Next: independently re-review the exact 110G connector remediation, then create one real signed enrollment through the
accepted connector, refresh all affected packet and implementation pins, and only then ask the owner for a new
attached-Terminal qualification window.

## CR12B-IDEA-110C — default-blocked enrollment readiness

Status: complete locally for the zero-effect readiness snapshot. See
`CR12B_IDEA_110C_ENROLLMENT_READINESS_ACCEPTANCE.md` and ADR-141.

One canonical digest-bound record now pins the exact fixed bridge, review packet, installed Hermes revision, connection
source, fixed RPC source manifest, operation set, and accepted second re-review. It records platform connector, trusted
node signer, signed enrollment, preflight, packet refresh, fresh owner authorization, and native qualification as absent.
Those seven gates cannot be re-digested into success, old owner text is non-reusable, no command is emitted, and all
connection/native/provider/network effect counts remain zero.

Review attempts #198 and #201 stopped before implementation review. Jobbers #202, #205, and #208 then preserved two
negative reports, two remediation rounds, and final accepted report PR #209. IDEA-110F implemented the first macOS
protocol guard for an injected Hermes Desktop private port. Independent jobber #211/PR #212 rejected it with two High
and three Medium findings. IDEA-110G closed four boundaries but its native AbortSignal observer remained vulnerable to a
poisoned built-in event map. IDEA-110H removes native AbortSignal objects from all repository component seams and
replaces them with a frozen, zero-key opaque cancellation capability backed by module-private state; only the
Mac-private port receives a newly created native signal. Next: independently review the exact IDEA-110H remediation,
then separately accept its trusted node signer and one signed connection enrollment before any native attempt.

## CR12B-IDEA-110H — opaque cancellation remediation

Status: complete locally for the provider-disabled implementation candidate; fresh independent review required. See
`CR12B_IDEA_110H_OPAQUE_CANCELLATION_REMEDIATION.md` and ADR-146.

Two IDEA-110G re-review processes stopped before publishing complete reports, so their queue records remain blocked and
cannot accept the candidate. One different reviewer nevertheless exposed a reproducible High defect: a genuine native
signal with unchanged outer shape could carry a Proxy in its mutable internal event map, and listener installation
executed caller behavior. IDEA-110H replaces that seam structurally across the driver, enrolled gateway, fixed bridge,
and connector. Opaque cancellation retains timeout, abort, settlement, and cleanup semantics without EventTarget or
caller-owned internal containers. A new independent report is required before connector acceptance.

Independent PR #219 rejected that exact candidate with two High and one Medium finding. See the retained report at
`docs/reviews/CR12B_IDEA_110H_OPAQUE_CANCELLATION_REVIEW_REV_001.md`.

## CR12B-IDEA-110I — exact cancellation-boundary remediation

Status: provider-disabled implementation frozen at `5c731e42bc54bc3dea88e079385b9616dd2042b4`; replacement
packet `sha256:1e16228a82d475941507213593c900ec94e0092054c53bdb9fcd18e97536e1ef` and fresh independent review required. See
`CR12B_IDEA_110I_CANCELLATION_BOUNDARY_REMEDIATION.md` and amended ADR-146.

Every gateway and fixed-bridge execute/cleanup entry now requires an exact repository-owned cancellation capability
before state, time, spend, settlement, or collaborator behavior. The Mac connector uses module-captured native
constructor/getter/abort operations; connector-owned cancellation becomes terminal before native abort, abort exceptions
are discarded, active settlement remains joined, and mandatory cleanup stays reachable. Four hostile regressions close
the exact PR #219 attacks. No private port, enrollment, native operation, provider call, credential access, or deployment
is introduced.

Independent review accepted closure of all three inherited defects but rejected IDEA-110I on one new Medium ambient
`Set` path after cancellation acceptance. See
`docs/reviews/CR12B_IDEA_110I_CANCELLATION_BOUNDARY_REVIEW_REV_001.md`.

## CR12B-IDEA-110J — host-operation capture remediation

Status: rejected by independent review. Exact product `5707ecb05221e708beefa196fc0fa2e0c9d8515d` is superseded by
IDEA-110K. See `CR12B_IDEA_110J_HOST_OPERATION_CAPTURE_REMEDIATION.md`, the immutable negative report, and amended ADR-146.

Dynamic collection distinctness is removed. Gateway, exact snapshot, bridge, and connector now capture or structurally
avoid mutable ambient time, number, Promise, JSON, freeze, reflection, receiver-binding, collection, and array-traversal
operations used after an exact cancellation signal is accepted. Three hostile post-import regressions require zero
behavior and bounded results. No private port, enrollment, native operation, provider call, credential access, or
deployment is introduced.

Independent review confirmed the IDEA-110I ambient-Set defect closed but found one new High bypass: both shared safety
walkers dynamically selected post-import `Object.entries`, allowing a replacement to traverse no fields and retain a
secret-bearing value. See `docs/reviews/CR12B_IDEA_110J_HOST_OPERATION_CAPTURE_REVIEW_REV_001.md`.

## CR12B-IDEA-110K — shared safety-walker capture remediation

Status: rejected by independent review. Exact product `2aa4f8e0dce52045100a2a10394d86bb934df93e` is superseded by
IDEA-110L. See `CR12B_IDEA_110K_SAFETY_WALKER_CAPTURE_REMEDIATION.md`, the immutable negative report, and amended ADR-146.

Secret detection/redaction and safe projection now capture or structurally avoid object-entry, array
identification/traversal/append/join, regex test/replace, string normalization/search, reflection, object definition, and
Error operations. Direct walker tests and actual connector/provider/cleanup tests replace the former ambient helpers,
require zero hostile behavior, retain secret rejection, prevent private prompt dispatch, and still complete mandatory
cleanup. No private port, enrollment, native operation, provider call, credential access, or deployment is introduced.

Independent review found one High and one Low defect: captured regex methods still dynamically resolved mutable
`RegExp.prototype.exec`, and indexed redaction materialized sparse-array holes. See
`docs/reviews/CR12B_IDEA_110K_SAFETY_WALKER_CAPTURE_REVIEW_REV_001.md`.

## CR12B-IDEA-110L — regex execution and sparse-array remediation

Status: provider-disabled implementation frozen at `c31a00b388292fe5af404f71eb2802b6aed52d1f`; replacement
packet `sha256:bfaef5a2c48930bf194af91f7d4cc844bc1492763632c03dddff9dd79c37cef6` and fresh independent review required. See
`CR12B_IDEA_110L_REGEXP_EXEC_CAPTURE_REMEDIATION.md` and amended ADR-146.

Pattern checks invoke captured native regex execution directly; key normalization uses primitive ASCII filtering; every
Idea Lab regex and datetime schema uses captured refinement operations; and sparse redaction preserves exact holes.
Dishonest and throwing exec regressions cover direct walkers, exact error classification, connector prompt admission,
provider-result filtering, and mandatory cleanup. No private port, enrollment, native operation, provider call,
credential access, or deployment is introduced.

Independent review confirmed the IDEA-110K findings closed but found two Medium chronology defects: post-import ambient
time replacement could accept an expired enrollment, and the replacement datetime refinement accepted impossible civil
times. See `docs/reviews/CR12B_IDEA_110L_REGEXP_EXEC_CAPTURE_REVIEW_REV_001.md`.

## CR12B-IDEA-110M — captured chronology and strict calendar remediation

Status: provider-disabled implementation frozen at `790524a7538f0e1d6c45e5023f5ecc3100e9c113`; replacement packet
`sha256:0b779430173a003a1abe90aa527e428d2895fc42a4eb088d157ebc1e0b6e644d` and fresh independent review required. See
`CR12B_IDEA_110M_CHRONOLOGY_CAPTURE_REMEDIATION.md` and amended ADR-146.

One captured strict-calendar boundary validates, parses, formats, and obtains Idea Lab time. Enrollment, profile,
owner, admission, authority, coordinator, lifecycle, generated evidence, spend, and persistence comparisons no longer
select ambient chronology operations after import. Hostile-substitution and calendar regressions cover the actual four
security boundaries. No private port, enrollment, native operation, provider call, credential access, or deployment is
introduced.

Independent review confirmed the inherited chronology and calendar findings closed but found two Medium defects:
captured formatting could emit timestamps outside the exact contract or leak an invalid-Date error, and actual roster
construction invoked caller/ambient array and collection behavior. See
`docs/reviews/CR12B_IDEA_110M_CHRONOLOGY_CAPTURE_REVIEW_REV_001.md`.

## CR12B-IDEA-110N — contract-safe formatter and inert roster capture remediation

Status: provider-disabled implementation frozen at `58fc3304b8b927252c6c0d0e3d8afc9c1b2039b5`; replacement packet
`sha256:c561cf781d944ec01943f5fd412adf64ad59e8dd61ab6a3205f815aab346804f` and fresh independent review required. See
`CR12B_IDEA_110N_FORMATTER_ROSTER_CAPTURE_REMEDIATION.md` and amended ADR-146.

Formatted time round-trips through the captured strict contract and all formatting failures remain controlled. Roster
construction exact-snapshots its request and bounded dense array, traverses by numeric index, compares identities
pairwise, and counts directly without selecting caller or ambient array/collection behavior. No private port,
enrollment, native operation, provider call, credential access, or deployment is introduced.

Independent review confirmed both intended IDEA-110N repairs but found one Medium defect: rebuilt roster records still
entered the shared canonical digest routine, which dynamically selected ambient array behavior. See
`docs/reviews/CR12B_IDEA_110N_FORMATTER_ROSTER_CAPTURE_REVIEW_REV_001.md`.

## CR12B-IDEA-110O — captured roster-digest remediation

Status: provider-disabled implementation frozen at `343eb645e6c10f9bb4e601ea49ae371fee2493ba`; replacement packet
`sha256:ab738a78c9ac9d4e7a1172979231a979f55109a07ab9589090a91b8cc7d44728` and fresh independent review required. See
`CR12B_IDEA_110O_ROSTER_DIGEST_CAPTURE_REMEDIATION.md` and amended ADR-146.

Roster canonicalization captures array identification and sorting, object-key enumeration, JSON and finite-number
handling, reflection, and SHA-256 methods at module initialization. Indexed construction selects no mutable ambient
traversal and preserves exact clean-runtime digest bytes. No private port, enrollment, native operation, provider call,
credential access, or deployment is introduced.

Independent review confirmed the captured digest repair but found one Medium defect: reparsed safe results and nested
roster connection/blocker evidence remained mutable after digest verification. See
`docs/reviews/CR12B_IDEA_110O_ROSTER_DIGEST_CAPTURE_REVIEW_REV_001.md`.

## CR12B-IDEA-110P — immutable connection-evidence remediation

Status: exact provider-disabled product `e028d6b4cd5ee55c053561a880fbf65d897dc2ad` accepted after fresh independent
review. Accepted report SHA-256: `7cbd2f982956ff418e35dfacf71ee616a763fe60e20eb0b4d40acf553581af3f`. See
`CR12B_IDEA_110P_CONNECTION_EVIDENCE_FREEZE_REMEDIATION.md`, `CR12B_IDEA_110P_ACCEPTANCE.md`, and amended ADR-146.

A module-captured freeze operation seals direct and reparsed safe results with their blocker arrays. Final roster
parsing seals every nested connection and blocker array before the connection array and outer projection. No private
port, enrollment, native operation, provider call, credential access, or deployment is introduced.

The completed different reviewer directly reproduced the predecessor mutation, confirmed recursive immutability for
direct, reparsed, empty, one-entry, and 32-entry results, repeated the inherited connector matrix, and accepted only the
provider-disabled implementation snapshot. Live configuration and every external effect remain separately gated.

## CR12B-IDEA-110 — owner-attended Hermes 0.21 native qualification

Status: blocked pending the fixed local/SSH native bridge, one real signed node enrollment, refreshed pins and review,
and another exact owner authorization. The policy port and durable spend store are complete. The IDEA-100 and IDEA-105
authorization text is non-reusable.

One no-effect preflight will verify the installed runtime and print the exact attached-Terminal command. The owner must
run it and handle any Keychain prompt. The attempt emits only a sanitized unaccepted candidate, cleans disposable state,
and never retries after uncertainty. Independent review and architect registry acceptance remain later gates.

## CR13A-LIVE-000 — authenticated resumable project activity

Status: accepted implementation candidate at `fcc2f10881aaf7a094db76e01a898b0e04fba083` after a third different-party
review closed all four blocking findings. Historical PR #218 is closed; verified restack PR #229 targets the accepted
connector-integration branch and remains dependent on the owner-approved merge of parent PR #228. See
`CR13A_LIVE_000_ACCEPTANCE.md` and ADR-147.

One PostgreSQL append-only event chain now projects safe project activity without becoming project or work authority.
Concurrent writers serialize, exact source replay is inert, changed replay fails, and event/head authentication detects
drift. The existing protected owner-project scope gates one bounded SSE replay endpoint. Browser-native reconnect resumes
with the last event ID; invalid, stale, foreign, and ahead cursors reset to bounded current truth. The shared Project
Workspace Activity tab shows the connection and event timeline, and the repository-fake pilot emits durable promotion
and lifecycle events across restart. After the first rejection, the source ledger is reconciled deterministically after
changes and at startup, canonical UTC time is required, and the real protected project mounts the Activity source. No
browser write endpoint, provider contact, production database, or deployment is introduced.

## CR13A-LIVE-010 — protected Connection Center

Status: implementation candidate complete at `e4cb8d69b4dbe17f560303a1edad08871fcc575b`; independent security/integrity
review required. See `CR13A_LIVE_010_CONNECTION_CENTER_ACCEPTANCE.md` and ADR-148.

The dashboard now links to a protected Connection Center with exact Hermes 0.21 compatibility, bounded local/SSH counts,
safe enrollment and qualification diagnostics, and explicit blockers. Authentication precedes every roster read. The
server rebuilds the accepted sanitized connection roster before projecting it, and the browser accepts only the strict
digest-bound response. The local pilot reports an honest protected empty roster until a real signed enrollment exists.
No hostname, locator, credential, provider call, native process, write control, or execution authority is introduced.

Next after review and ordered parent integration: CR13A-LIVE-020 adds durable protected connection-registry persistence
and composes independently authenticated node freshness without treating enrollment, liveness, compatibility, or
qualification as interchangeable. Use Sol high for that persistence/security boundary.

## CR13A-LIVE-020 — durable connection registry and authenticated signal freshness

Status: accepted implementation candidate `ed5bb96d2a80c6fa98bf68d2a118ed2501a22384`; integration pending. Two negative
reviews and the final accepted independent confirmation are preserved. See `CR13A_LIVE_020_CONNECTION_REGISTRY_ACCEPTANCE.md`
and ADR-149.

Migration 0034 and `ConnectionRegistryStoreV1` persist the already-sanitized signed Hermes enrollment result as a
tenant- and canonical-node-bound append-only revision. A per-tenant digest chain and authenticated stream head, keyed row authentication, payload digests, exact-replay handling,
monotonic renewal, active-route/profile uniqueness, capacity bounds, protected reconstruction, and database mutation
guards make restart truth deterministic without exposing protected identifiers. The repository-fake pilot uses this
registry instead of an in-memory empty source.

Connection Center separately reads a server-keyed receipt emitted only after node-protocol authentication and fleet
persistence. It does not read the mutable fleet-current projection. Only a current bounded receipt can be shown as a
recent signal; expired/future receipts are stale, absence is missing, and direct fleet rows, discovery,
capability, or benchmark evidence does not imply recency. Enrollment, exact-version compatibility, signal freshness,
qualification, live-panel eligibility, and execution authority remain distinct. Browser output retains only ordinal
presentation references and safe timestamps. No ingestion endpoint, SSH action, provider call, credential access,
production database, or deployment is added. The immutable first review remains rejected because it proved that the
earlier target trusted a directly inserted current row and executed behavioral database/roster/projection values. A
different remediation reviewer closed those security findings but rejected a remaining cumulative whitespace defect. A
final independent confirmation accepted the documentation-only repair after proving the product tree remained identical,
the reports remained intact, the exact whitespace gate passed, and focused behavior remained 15/15.

Next after independent acceptance and integration: CR13A-LIVE-030 should add the protected server-side enrollment intake
composition that connects the existing signed enrollment verifier to this registry, with exact replay and audit evidence,
while retaining all native/provider effects as separately gated work. Use Sol high for that security/integration boundary.

## CR13A-LIVE-030 — protected server-side enrollment intake

Status: independently accepted immutable product `0bbe4e52602f8859b78ca6516377bdbe3ee3378a`; integrated through PR #232 as
`10605afd4a5e8d3baeafeab82ec883f6008e845b` with passing post-merge CI. The different reviewer reported no High,
Medium, or Low findings. See
`CR13A_LIVE_030_ENROLLMENT_INTAKE_ACCEPTANCE.md` and ADR-150.

Migration 0035 and `ConnectionEnrollmentIntakeServiceV1` connect the accepted signed Hermes 0.21 enrollment verifier to
the durable connection registry. A server-held source supplies a bounded delivery, but its label grants no trust. Inside
one tenant-locked transaction, Control Room verifies the complete intake audit stream, resolves the current active node
key from PostgreSQL, verifies the exact enrollment signature and scope, writes the registry revision, and appends the
authenticated audit receipt. Registry and audit either commit together or both roll back. Exact replay returns the
original verified receipt; delivery/enrollment drift fails closed.

The safe receipt exposes only opaque digests, a derived intake reference, registry revision, chronology, and negative
authority. Raw tenant, node, connection, enrollment, key, route, profile, host-key, public-key, and signature data remains
server-side. The local pilot uses a disabled source and no HTTP or browser enrollment mutation exists. This block performs
no native launch, SSH connection, Hermes/provider call, credential access, production database contact, or deployment.

Next after independent acceptance and integration: CR13A-LIVE-040 may add the authenticated node-protocol delivery
adapter behind the protected source and keep it disabled by default. Use Sol high for review/integration; use Sol xhigh
if LIVE-040 changes signed node-protocol schemas or the live ingress trust boundary.

## CR13A-LIVE-040 — authenticated node-protocol enrollment delivery

Status: independently accepted remediation `67c16c5c11d06d3752b434fd8e3641c1c1482e8b` after immutable product
`6493118f2b7272308d3c508b963f3ddd52cc9863` was rejected; integrated through owner-approved PR #233 as
`34379984d3c4793f2c2d464ffb3545ab98717ba5`. See
`CR13A_LIVE_040_AUTHENTICATED_NODE_DELIVERY_ACCEPTANCE.md`,
`docs/reviews/CR13A_LIVE_040_INDEPENDENT_REVIEW.md`, and ADR-151.

The `connection.enrollment.deliver` node-to-server message binds one opaque enrollment envelope to the authenticated
tenant, node, active key, connection, sequence, nonce, lifetime, delivery ID, contract, and envelope digest. Migration
0036 and `DatabaseConnectionEnrollmentNodeDeliveryAdapterV1` preserve accepted deliveries in a tenant-serialized,
append-only, authenticated digest chain. Exact duplicate delivery is inert; identity/content conflict fails closed; and
an exact retry can complete a missing ledger append after protocol replay committed but delivery persistence failed.

The adapter is the protected source consumed by CR13A-LIVE-030, whose independent active-key lookup and inner enrollment
signature verification remain unchanged. The outer node frame is transport authentication, never enrollment authority.
Safe receipts contain derived references and digests only. No HTTP/browser mutation, listener, live connector, SSH,
Hermes/provider call, credential access, production database, or deployment is enabled.

The frozen remediation verifies host-operation selection, gives the generated schema an honest strict structural
boundary plus runtime-only relational checks, preserves replay's original receive time and original safe receipt, and
enforces one delivery-ID contract before replay and through protected intake and storage. The first negative review stays
durable and cannot authorize integration. The zero-repair remediation packet has SHA-256
`f3c9b605b3646d2f518000f144163d09973fa9174dc9488d1ddc29e84aa96733`. A fresh different reviewer independently
closed all four findings with no new High, Medium, or Low finding; accepted report SHA-256 is
`217dd95aca1f314038b9730183e86bbb644464fa75a5be407c2d899c7135b516`. The report authorizes integration review only,
not a live effect.

Next after independent acceptance and owner-approved integration: CR13A-LIVE-050 may compose a provider-disabled server
ingress boundary or prepare one bounded enrolled-connector rehearsal without enabling a live effect. Use Sol xhigh if the
next block changes transport trust or any signed contract; otherwise use Sol high for review/integration.

## CR13A-LIVE-050 — provider-disabled enrollment ingress composition

Status: independently accepted for exact provider-disabled product `ffcdb586022ff67494cb2e404df7749b3a093b22`;
owner-approved integration pending. See
`CR13A_LIVE_050_PROVIDER_DISABLED_INGRESS_ACCEPTANCE.md` and ADR-152.

The server-only coordinator composes authenticated node delivery, protected ledger re-read, exact routing-hint/evidence
binding, and independent enrollment intake into one byte-stable safe receipt. The database composition requires separate
delivery, registry, and intake-audit HMAC keys. Outer transport authentication still cannot replace inner enrollment
authorization, and no transport-provided label can select a different pending delivery.

The repository-fake local runtime holds only a disabled ingress port. No application route, listener, connector,
SSH/Hermes/native action, credential access, provider call, production PostgreSQL/VPS contact, deployment, or network
effect is added.

The zero-repair independent review packet is
`docs/reviews/CR13A_LIVE_050_PROVIDER_DISABLED_INGRESS_REVIEW_PACKET.md`, SHA-256
`8836319fe7d396a73d93192db10a0bf97eece09e4d85b463a32470a67063ac8c`.

The independent report rejected the exact target with one Medium finding: mutable ambient canonicalization could execute
after import and make a drifted final receipt pass its original digest. Rejected report SHA-256:
`ae40c366c16ac9d72cdc0be6db0393fd02904eef77b07b3e04bd8a07b7c6b255`. Preserve that negative evidence. Remediation must
re-establish the selected runtime after awaited seams and before receipt construction/parsing, then receive a different
independent re-review.

The remediation candidate captures the complete canonicalization/hash runtime selected by the ingress receipt, checks it
at public entry and after every awaited proof seam, and uses captured slicing/cleanup operations. A 20-operation direct
replacement matrix and a separate change injected after successful intake commit both fail before the replacement can
execute. The committed result remains exactly recoverable after the original call closes. The change does not alter the
wire contract, persistence, proof ordering, receipt schema, disabled runtime, or external-effect boundary.

The zero-repair remediation closure packet is
`docs/reviews/CR13A_LIVE_050_REMEDIATION_REREVIEW_PACKET.md`, SHA-256
`5ed0af3e0552fbd4722211bf035b6bc705c50624ccca3c45445c0906b11bd1a9`.

That re-review closes M-001 but rejects the exact target with inherited Medium M-002. A self-throwing Proxy rejection can
execute through node-delivery and ingress `instanceof` classification and escape raw before persistence. Rejected report
SHA-256: `67b8eaeffd6bbcc86eb81d061107beaf464b5dcb0f680317ad3d18cb89c85992`. The next remediation must classify caught
unknown values behavior-free, preserve only bounded codes, and prove zero persistent writes.

The second remediation removes behavioral rejection classification from the registry, intake, node-delivery, and
ingress catch boundaries. A shared host-level classifier rejects direct Proxies, requires the exact immediate local
error prototype, and reads only an own string data descriptor. Every accepted code is reconstructed as a fresh bounded
local error; any other value becomes bounded failure. Direct-Proxy and unusual-prototype database regressions execute no
caller behavior and create no delivery, intake, or registry records. The exact frozen target is
`bbd3bcbd659ab91461bb52117718a95098c7bb80`; its zero-repair packet is
`docs/reviews/CR13A_LIVE_050_ERROR_CONTAINMENT_REVIEW_PACKET.md`, SHA-256
`f60a27488b7751a3630c16e31704a326445809acfdd2398c263ed8e0c7fbbfeb`. The review closes M-001 and M-002's reported
defects but finds Low L-001: the node-delivery authentication catch must compare the captured code with the protocol's
seven-code allowlist rather than accept every string. The rejected report SHA-256 is
`61c934aca63942f043b613e5137b1ba2824f5f2139534031ba62ad65e732a86b`. A narrow third remediation and another different
review are required before integration.

The third remediation explicitly compares the captured protocol-authentication code with all seven declared literals
and maps every other string to conservative integrity failure. Adapter and complete-ingress regressions prove the
unknown value runs no behavior, cannot escape raw, and creates no delivery, intake, or registry record. The exact frozen
target is `ffcdb586022ff67494cb2e404df7749b3a093b22`; its zero-repair packet is
`docs/reviews/CR13A_LIVE_050_ALLOWLIST_REMEDIATION_REREVIEW_PACKET.md`, SHA-256
`34e6475f0d62eecc0989573e9cc6caf7d0550367e74e39f32b7c3f310ec6cb22`. A fourth different reviewer reproduced every
required gate and found no High, Medium, or Low defect. M-001, M-002, and L-001 are closed. Accepted report SHA-256:
`a172987b0a73d4b82698b4ae2515a57bd773b37d2242b3a2f83000120813e95d`. This permits owner-controlled integration only;
no ingress listener or external effect is enabled.

Next after independent acceptance and owner-approved integration: define one bounded transport-admission contract or
refresh one enrolled-connector rehearsal packet without running it. Use Sol xhigh for any transport/listener trust
boundary; use Sol high for a packet-only refresh under frozen contracts.

## CR13A-LIVE-060 — bounded transport admission

Status: exact effect-free product `cee64a8197a011a91c06e6085d5f4d11e978ddbc` rejected by independent review over
owner-approved LIVE-050 integration `5a94bfd7f28d336274f6b29ad50575eb5a90a9b1`; Medium M-001 and Low L-001 require
remediation and another different review. See `CR13A_LIVE_060_BOUNDED_TRANSPORT_ADMISSION_ACCEPTANCE.md`, the preserved
negative report, and ADR-155.

The server-only admission accepts exactly one string frame and untrusted delivery routing hint. It enforces a strict
UTF-8 byte ceiling before time or ingress use, takes chronology only from a synchronous server clock, and derives
transport rate-limit identity from frozen policy plus a digest-only channel identity. Configuration admits only an SSH
tunnel at private loopback. That is a policy contract, not proof of a real bind address; the block opens no listener and
performs no network I/O.

Only an exact intrinsic native Promise may cross the ingress seam. Foreign thenables, Proxies, Promise subclasses, own
string properties, and intrinsic `constructor`/`then` drift fail before assimilation. Unknown rejected values retain no
behavior or raw identity, and only explicitly allowed ingress codes survive as fresh local admission errors. The safe
receipt is strict, digest-bound, replay-stable, secret-free, and denies listener, I/O, approval, network, command, lease,
and execution authority. Local pilot composition remains disabled and the app exposes no admission route.

The deterministic gate passes 22 focused admission/ingress tests, 50 connection tests, the complete lifecycle,
TypeScript, full lint, production build/render, all 36 migrations with 119 PostgreSQL tables, and whitespace validation.
The zero-repair packet SHA-256 is `0aa34793dff6ffd56d5cef026a250a170e5af12119d3ab7fe91ed199d6cb762f`.
The first independent review rejects exact product `cee64a8...`. A rejected intrinsic Promise that fails the own-string
shape rule is not observed and can emit its raw rejection through Node's process-level `unhandledRejection` channel.
The report also corrects the connection gate from 50/50 to 51/51. Preserve the report, repair without assimilating
foreign thenables or executing Proxy/accessor/subclass behavior, and require a different zero-repair re-review before
publication or integration. Rejected report SHA-256:
`d53bd172753ee77feb445bedaa0616080a8a74cf302ea12df1058de8454c7342`.

The exact remediation is frozen at `45b4a67477fb39811d02ba1b1a67e8c78cf98ee9`. A safely observable malformed
Promise must be a non-Proxy exact same-realm intrinsic instance with unchanged captured prototype constructor/then,
unchanged constructor species getter, and no instance constructor override. The boundary calls only the captured native
method with inert handlers; it never reads a supplied `then` or instrumentation accessor. Strict unhandled-rejection and
process-event regressions prove a decorated rejection creates one bounded local result without raw escape. Foreign
thenable/Proxy and Promise runtime replacements execute zero behavior.

Corrected gates pass 24/24 focused admission/ingress, 53/53 connections, and 304/304 posttests, plus the unchanged full
pretest/core lifecycle, TypeScript, lint, build/render, migration, and whitespace gates. A different reviewer must close
M-001 and L-001 with no new finding before publication or integration. Closure-packet SHA-256:
`07012b512f220f2972f038dcd01b32d29baefc3f7ad0d47ce505b8d21ae6e6b0`.

The different zero-repair reviewer reproduced the complete required gate and private Promise-cleanup probes against the
exact remediation. M-001 and L-001 are closed with no new High, Medium, or Low finding. The accepted report is
`docs/reviews/CR13A_LIVE_060_REMEDIATION_REREVIEW.md`, SHA-256
`a835b28501c90797295066cbbe99ad7c1cd357035997b8a96bbb301fb67df4f6`. This authorizes ordinary GitHub integration review
only and does not enable a listener or another external effect.

Next after independent acceptance and owner-approved integration: define a disabled private-loopback listener adapter or
refresh the owner-attended connector rehearsal. Continue with Sol xhigh if code touches listener, transport, identity,
chronology, authentication, credentials, or signed evidence; use Sol high only for a packet-only refresh under frozen
contracts. No socket, SSH, Hermes/provider, credential, native, production-database, deployment, or DNS effect is
authorized by this block.

## CR13A-LIVE-070 — private-loopback single-frame decoder and disabled listener port

Status: implementation candidate over owner-approved LIVE-060 integration
`a6c08e1553cbb6d3e3db0e262a5e115c8356c664`. See
`CR13A_LIVE_070_PRIVATE_LOOPBACK_FRAMING_ACCEPTANCE.md` and ADR-156.

The effect-free decoder accepts fresh exact `Uint8Array` chunks for one unsigned-big-endian-length-prefixed fatal UTF-8
JSON frame. Exact fixed configuration permits only a future IPv4 `127.0.0.1` SSH-tunnel listener, bounds frame bytes and
chunk count, rejects incomplete/multiple/trailing frames, wipes internal buffers, and makes every completion or failure
terminal. It extracts only the untrusted enrollment delivery-ID routing hint. LIVE-060 admission, LIVE-050 outer-frame
authentication, and LIVE-030 inner enrollment verification retain their separate authority.

The protected internal handoff binds raw frame, byte count, routing hint, and framing/listener policy. It denies every
effect authority and reduces to the exact two-field LIVE-060 request. The local pilot wires only a disabled listener
port. No networking/process module, socket, SSH connection, browser route, credential, provider, or production service is
added.

Completion requires the complete deterministic lifecycle, an immutable product, and independent review with no open
High, Medium, or Low finding. After acceptance and integration, the next block may implement a separately authorized
private-loopback listener or refresh an owner-attended connector rehearsal packet. Use Sol xhigh for a listener or
transport security boundary. No physical bind or external effect is authorized here.
