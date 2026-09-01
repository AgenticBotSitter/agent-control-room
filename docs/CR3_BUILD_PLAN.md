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

Next: add the broker-private durable one-use permit and cleanup state machine, then implement/review the upstream method
before refreshing the owner packet.

## CR12B-IDEA-110 — owner-attended Hermes 0.21 native qualification

Status: blocked pending a reviewed profile-isolation remediation, refreshed pins, integration, and another exact owner
authorization. The IDEA-100 and IDEA-105 authorization text is non-reusable.

One no-effect preflight will verify the installed runtime and print the exact attached-Terminal command. The owner must
run it and handle any Keychain prompt. The attempt emits only a sanitized unaccepted candidate, cleans disposable state,
and never retries after uncertainty. Independent review and architect registry acceptance remain later gates.
