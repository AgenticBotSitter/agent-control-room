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

Status: exact product `ff00d3ffdcc5afd59bc0cc31d8a29e685fb6d587` rejected over owner-approved LIVE-060
integration `a6c08e1553cbb6d3e3db0e262a5e115c8356c664`; M-001, M-002, L-001, and L-002 are closed in independently accepted
immutable product `8e4c20da7166d48cb22c06fd38dfe87ee0016a02`; ordinary integration remains owner-controlled. See
`CR13A_LIVE_070_PRIVATE_LOOPBACK_FRAMING_ACCEPTANCE.md` and ADR-156.

The effect-free decoder accepts exact full-backing-store `Uint8Array` chunks for one unsigned-big-endian-length-prefixed fatal UTF-8
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

The independent review reproduced every functional gate but rejected integration. M-001 proves the public SHA digest
cannot establish decoder provenance or prevent a caller from manufacturing a changed handoff. M-002 proves native JSON
parsing accepts duplicate lexical members with last-member routing. L-001 corrects the unprovable alias-rejection claim
to exact full-backing-store input, synchronous internal copy, and no retention. L-002 records the immutable product's two
trailing-whitespace lines. Preserve the negative report and remediate all four findings before a different zero-repair
re-review. Report SHA-256: `91f9e00c41d7b3a47efab3619d6ac33dee5236c34f6c151c6ca94d42a9487ae6`.

The remediation gives decoder-created frames module-private provenance, re-extracts delivery identity from the exact raw
frame before reduction, and rejects duplicate JSON members at every nesting level, including escape-equivalent names.
The corrected binary assurance is exact full ordinary backing-store coverage, synchronous private copy, and no
caller-buffer retention; post-push alias mutation is proven irrelevant. The remediation passes 23/23 focused tests,
65/65 connection tests, the complete repository lifecycle, build/render, migration, type, lint, and whitespace gates.
Different-reviewer packet SHA-256: `5bf992f81c136b0e4f32e4095dd5eaa16a86bb29cbfda8f42cdf14215928c9dd`.
The accepted report SHA-256 is `7ac1a5fa117b70556e2d73da80e729ebb0703161e747db6d2ce58ea12fe2a0c0`; it
found no new High, Medium, or Low defect and grants integration review only.

## CR13A-LIVE-080 — private-loopback listener lifecycle contract and fake rehearsal

Status: exact remediation `884ff423914ab4e442500bd194970b0713da72ca` independently accepted over
owner-approved LIVE-070 integration `b0b129824f99dbaeb86f7cc6eac4001530fbe1fa`; ordinary owner-controlled
integration remains. See
`CR13A_LIVE_080_PRIVATE_LOOPBACK_LISTENER_LIFECYCLE_ACCEPTANCE.md` and ADR-157.

This block defines the exact lifecycle around the accepted LIVE-070 decoder without opening a listener. One strict,
digest-bound policy plan fixes IPv4 literal loopback over an SSH tunnel, endpoint/owner/tunnel-peer/host-key/channel
identity digests, frame/chunk limits, exactly one active connection, zero queued connections, one frame per connection,
total/idle/shutdown deadlines, and no automatic restart. The public plan is non-authorizing policy; its unkeyed digest
proves consistency only.

The repository-fake rehearsal admits six exact ordered observations: simulated bind, connection open, protected frame,
connection close, drain start, and listener close. Chunk, connection-age, idle-age, and shutdown chronology are bounded
and monotonic. Every observation is explicitly fake and rejects native evidence.
Only a module-private LIVE-070 decoder-minted frame bound to the same listener may pass. Identity drift, excess capacity,
deadline breach, sequence drift, added or behavioral input, cleanup failure, incomplete finish, and any reuse after a
terminal result fail closed.

The safe receipt contains only digest/size/policy evidence and explicitly denies actual bind, exclusive port ownership,
tunnel authentication, host-key custody, native cleanup, listener enablement, network I/O, and all approval/effect
authority. A recomputed public digest cannot change those exact negative literals into native truth. Local-pilot wiring
remains the accepted disabled listener; no socket, SSH, credential, Hermes/provider, native process, route, production
database, deployment, DNS, or external effect is added.

Plan and receipt hashing reuses the accepted enrollment-ingress runtime-custody assertion. Selected post-import
canonicalization, reflection, pattern, typed-array, or hash operation replacement fails before changed behavior runs.

Completion requires the full deterministic repository lifecycle, immutable product freeze, a zero-repair packet, and a
fresh independent review with no open High, Medium, or Low finding. Independent acceptance permits owner-controlled
integration only. A physical listener, SSH tunnel, credential operation, or native qualification remains a new,
separately authorized block. Use Sol xhigh throughout this listener-security boundary.

The exact review target is `4ecc453f9ac0f6d6edb30455620d0b8fa0a90c3e`, containing frozen implementation
`7333ea48577b1000fd5eac0e6789b3e21cfeb559`. Zero-repair packet SHA-256:
`00c005a2371f20dc4de66685659f9fde7a0bd6513627829fd7894ace0451f4a0`.

Independent review reproduced every deterministic gate and the no-effect claims but found one Medium and two Low
defects. Exact remediation `884ff423914ab4e442500bd194970b0713da72ca` retains only digest/size/chunk frame facts,
clears all evidence on every terminal failure, enforces the receipt listener-ID ceiling, rederives the rehearsal
reference from `planDigest`, and adds regressions for the reported paths and exact bounds. Preserve the rejected product
and report. A different zero-repair reviewer must independently reproduce closure. Negative report SHA-256:
`0f43e735ce30fe418dd93a4d5221497dde25b9f3c50d95c501f1322064bc7688`.
Remediation re-review packet SHA-256: `a65f0be8d60cc5bcfdbc2f60ecea3e6c2e055594b79a738419245817f0d72271`.
The different reviewer reproduced every deterministic gate and hostile-probe family, closed M-001, L-001, and L-002,
and found no new High, Medium, or Low defect. Accepted report SHA-256:
`3e5ea006098cf51222e62296e5cb80b924b4da5dab0d319e188e4073a3d5b6f1`. This permits ordinary owner-controlled
integration only and grants no listener, SSH, credential, native, provider, production, deployment, or network authority.

## CR13A-LIVE-090 — one-frame listener-session and authenticated admission composition

Status: independently accepted after three remediation rounds and integrated through owner-approved PR #238; exact third remediation
`77ef10c2ec9d0912e4d59ca71c95b1886c9ae60e` reviewed over owner-approved LIVE-080 merge
`04dfd7958b7b030ff00cbcda0ba0d8329ea31e3d`; ordinary owner-controlled integration permitted. See
`CR13A_LIVE_090_PRIVATE_LOOPBACK_LISTENER_SESSION_ACCEPTANCE.md` and ADR-158.

This block composes one accepted private-loopback frame and the repository-fake listener lifecycle into exactly one
authenticated transport-admission call. The session owns actual decoder chunk counting, module-private protected-frame
creation, raw-input reduction, a digest of the exact admission input, single-flight admission, listener/admission policy
matching, ordered close/drain/cleanup, reduced evidence clearing, and one public-safe correlation receipt.

The session neither opens nor implements a listener. It has no socket, SSH, network, process, credential, route, or
local-pilot integration. Listener evidence remains repository fake and every native/effect/authority claim remains
false. Admission cannot be retried or interrupted after its native promise is accepted; concurrent or wrong-order calls
cannot revive, duplicate, or corrupt it. A future native adapter must independently enforce wall-clock timeouts and
backpressure and prove physical bind, port exclusivity, tunnel/host-key identity, shutdown, and cleanup.

Completion requires immutable implementation, the complete deterministic repository lifecycle, a zero-repair attack
packet, and a fresh independent reviewer with no open High, Medium, or Low finding. Use Sol xhigh for the protected-byte,
async-settlement, and cleanup boundary. Independent acceptance permits ordinary owner-controlled integration only.

The exact review target is `dbdb297aa04ea7465ab636c94ccf1084003cdf27`, containing frozen implementation
`5ff9d9bf8ce3096c50c0fab646f60cfb36a410fe`. Zero-repair packet SHA-256:
`88dc35513f595fc08b75b0136bb20c7addb46bbcc8f837a265cd5df25c81d97f`.

The first reviewer rejected that immutable target. M-001 proves `finish()` could destructively fail and clear a session
while its sole admission was still pending, leaving a later successful settlement unable to complete the required
cleanup and receipt sequence. Preserve the negative report; SHA-256:
`0f3db267c28605f0687d18f831c303c9c1055a6b4e9f64be65b9b50dd3e716bd`.

Exact remediation `28a1c0833e8e2b2b3368644536b7442c96bbadcb` rejects `finish()` during `admitting` as a
non-mutating state conflict before any runtime assertion or evidence mutation. Async-pending and synchronous-reentrant
regressions prove the first admission can settle, cleanup can complete, one receipt can be emitted, and the method is
called exactly once. Producer gates pass at 43/43 focused tests, 85/85 connection tests, 769/769 pretests, 419/421 core
tests with two intentional platform skips, 336/336 posttests, production build plus 4/4 rendered routes, and all 36
migrations with 119 tables. A different zero-repair reviewer must close M-001 and find no new High, Medium, or Low
defect before owner-controlled integration. The immutable remediation review target is
`89be9d7fb486a3fb5855402073466108a19a75ec`; packet SHA-256:
`5be8352094f95217c35ff171181d5a3494ed5fff67d4cf11e9dc82d67dbdcc36`.

That reviewer closed M-001 but rejected the target for M-002. A malformed already-rejected same-realm Promise with an
inert own `constructor` data property selecting the captured native Promise constructor remained unobserved and could
terminate strict Node rejection handling. Preserve the second negative report; SHA-256:
`ca1b7ef365cd6a9b4fe79e22eade3d48667a8ccc1d8befc2f09bcb6f469803f2`.

Exact second remediation `de840c9aef259db18da3c45e1d4e0549bc0f0d85` preserves rejection of decorated Promises
while safely attaching the captured settlement observer when the own constructor is an inert data descriptor selecting
the captured native constructor or native default. Behavioral/accessor or foreign constructor selections, Proxies,
subclasses, and foreign thenables remain unexecuted and unassimilated. The same Promise boundary in LIVE-060 transport
admission is hardened, and strict-process regressions cover both layers while a behavioral-constructor regression
proves no getter runs. Producer gates pass at 46/46 focused, 88/88 connections, 769/769 pretests, 419/421 core with two
intentional platform skips, 339/339 posttests, build with 4/4 rendered routes, 36 migrations/119 tables, type, lint,
stage zero, and whitespace. A third zero-repair reviewer must close M-002, reconfirm M-001, and find no new High,
Medium, or Low defect. The immutable second-remediation review target is
`f0a64ae4fab6b0a7d926fca573c9ce324c6b9ee3`; packet SHA-256:
`32e552933c8b3f6f7b65b0642bd45352b53f16bee00cdf7311804da67830e15b`.

The third reviewer reconfirmed M-001 and closed M-002 but rejected the target for M-003. Ambient
`Promise.prototype.then` drift correctly invalidated a dependency result but unnecessarily disabled the already
captured safe settlement observer, permitting a pre-rejected malformed result to reach strict Node rejection handling.
Preserve the third negative report; SHA-256:
`7870ea50f7c84edcd41adffa00191df8f504e3d85099c1d7dae50c37bb78ccfe`.

Exact third remediation `77ef10c2ec9d0912e4d59ca71c95b1886c9ae60e` separates strict Promise acceptance from
safe rejection cleanup. It uses only captured descriptors and intrinsics to prove native default/captured
constructor-and-species selection, observes the rejected settlement, and still returns local integrity failure without
calling ambient replacement behavior. Both listener and transport seams observe before failure on detected runtime
drift. Strict-process regressions cover both and prove replacement calls remain zero. Producer gates pass at 47/47
focused, 89/89 connections, 769/769 pretests, 419/421 core with two intentional platform skips, 340/340 posttests,
build with 4/4 rendered routes, 36 migrations/119 tables, stage zero, type, lint, and whitespace. A fourth zero-repair
reviewer was required to close M-003, reconfirm M-001/M-002, and find no new High, Medium, or Low defect. The immutable
third-remediation review target is `a94241fb4578af7ff8ba2b85afa4d18f2fdd4066`; packet SHA-256:
`82991aed6c64442addd44e7b4c317888264ed2524f2f3f8e0fab5a818d3f5423`.

The fourth different zero-repair reviewer reproduced the exact gates plus a 29/29 hostile matrix, closed M-003,
reconfirmed M-001/M-002, and found no new High, Medium, or Low defect. The unchanged accepted report is
`docs/reviews/CR13A_LIVE_090_THIRD_REMEDIATION_INDEPENDENT_REREVIEW.md`; SHA-256:
`cd02d7638fa50157db73c54758484dde3f633d2b3814973b577a49679793c4cf`. The disposable review clone was removed and
the shared checkout remained clean. This permits ordinary owner-controlled integration only and grants no listener,
SSH, credential, native, provider, production, deployment, DNS, hosting, or network authority.

Owner-approved PR #238 merged accepted branch head `ecb5ea373ccb0cdbee1ef036b80ee29730a3ec0b` to `main` as
`65ea851c123993d7760d6492966845f74ca1d665`. PR CI run `33784095714` and post-merge run `33785601437` passed.

## CR13A-LIVE-100 — default-disabled native-listener adapter contract

Status: independently accepted after two remediation rounds; immutable target
`2efc17abf0f04325e0f462420f0bccc319c07d43`; ordinary owner-controlled integration permitted. See
`CR13A_LIVE_100_DEFAULT_DISABLED_NATIVE_LISTENER_ADAPTER_ACCEPTANCE.md` and ADR-159.

This block freezes the exact non-authorizing contract immediately before any future physical listener. One readiness
record binds a derived non-locator listener reference and accepted plan digest to literal IPv4-loopback,
private-unpublished-port, one-active, zero-queued, one-frame, and no-restart policy. It then records twelve required
native/owner/platform/deadline/backpressure/cleanup/recovery gates as absent, fixes activation and all effects false,
and reports zero attempts.

The default-disabled adapter owns no native driver and accepts no activation evidence. Its `start()` always returns a
bounded disabled error and its repeatable `close()` performs no operation. The remediated class rejects subclasses,
freezes exact-branded instances and its prototype, bounds receiver misuse, and supplies a frozen binder over captured
base operations for future composition. The module is exported but remains absent from local-pilot, browser, HTTP,
Hermes, worker, and service composition. It imports no networking/process module and contains no listener, connection,
SSH, provider, credential, or deployment operation.

The first independent review rejected the original target for an alterable adapter surface (M-001), public re-digested
readiness identity substitution (L-001), and locator-shaped listener-ID retention (L-002). Its unchanged negative report
is `docs/reviews/CR13A_LIVE_100_INDEPENDENT_REVIEW.md`; SHA-256:
`8cf72b4cad7abe66705612421b642e56a7d1d5af3aebc7ab21ab5e7866fb3f6c`.

First remediation accepts only module-minted frozen readiness records, omits the raw listener ID in favor of a derived
non-locator reference, and closes adapter subclass, prototype-method, instance-field, and receiver substitution. The
focused suite passes 55/55, the complete connection slice passes 97/97, and the full repository lifecycle passes
769/769 pretests, 419/421 core tests with two intentional platform skips, and 348/348 posttests. Type, full lint,
production build with 4/4 rendered routes, all 36 migrations/119 tables through the listener-free verifier, stage zero,
and whitespace validation pass.

The different remediation reviewer closed L-001 and L-002 but rejected target
`ea81bf82ef4726aa230841420beaca6e96f162cc` with remaining M-001 and new L-003. The enclosing binder was frozen, but
its three function values were not individually frozen; immutable diff checks also classified preserved Markdown hard
breaks as trailing whitespace. The second negative report is
`docs/reviews/CR13A_LIVE_100_REMEDIATION_INDEPENDENT_REREVIEW.md`; SHA-256:
`bcf4a8aa173c4c898205adc7b6cb4c1431f6105a8cae7719e43e5d5202db708e`.

Second remediation `fbfdda99c8063f043bee6166ab664ba494382c85` freezes and makes non-extensible each bound function
before freezing the binder, with own-`call`, function-property, and prototype-chain mutation regressions. A narrowly
scoped `.gitattributes` rule preserves the exact three immutable evidence files while disabling only their
trailing-space classification. The base-to-target, original-to-target, and working-tree diff checks now pass.

The third different zero-repair reviewer reproduced every deterministic gate, all three immutable diff checks, exact
evidence hashes, narrow whitespace behavior, and a 15/15 hostile matrix. It closed M-001 and L-003, reconfirmed L-001
and L-002, and found no new High, Medium, or Low defect. The accepted report is
`docs/reviews/CR13A_LIVE_100_SECOND_REMEDIATION_INDEPENDENT_REREVIEW.md`; SHA-256:
`8a9ac5c6191303e75d8957fa776844639e6ecb4f4a56aab9b0c687d4f2fdc465`.

Independent acceptance permits ordinary owner-controlled integration only. It grants no right to add a native
driver, open a listener, select/expose a port, start SSH, read credentials, contact Hermes/provider, run a native
qualification, touch production, deploy, change DNS, or use external network. Use Sol xhigh.

Owner-approved PR #239 merged accepted branch head `7a11d6b132b7016a63a4e160ce049b29dcff21db` to `main` as
`d1d2b8723797cd2d09efc70384fa98403223a8ec`. PR CI run `33793948835` and post-merge run `33796044403` passed.

## CR13A-LIVE-110 — native-driver and activation-evidence contract

Status: local effect-free implementation candidate `8d0e7aebf379b0898a0fbbedb11cafc94159d2ab`; independent
zero-repair review required. See
`CR13A_LIVE_110_NATIVE_DRIVER_ACTIVATION_EVIDENCE_ACCEPTANCE.md` and ADR-160.

This block defines the exact contract a future physical native listener must implement without adding that
implementation. One module-created contract binds the LIVE-100 disabled readiness, accepted listener plan, safe
listener reference, fixed five-operation set, all capacity and deadline limits, and every required port, tunnel,
host-key, backpressure, shutdown, and recovery proof. It remains repository-fake-only, accepts no activation input,
and fixes every effect and authority claim false.

The exact-branded repository fake accepts no callback or behavioral input. It rehearses six fixed declarative events,
proves only the repository contract shape, and records zero native attempts, listener attempts, network observations,
or external effects. Frozen captured operations prevent caller method, prototype, receiver, or lookalike substitution.

The activation-evidence assessment consumes only exact module-created readiness, contract, and fake rehearsal records.
It binds their digests and identities but retains all twelve LIVE-100 blockers. Even a complete fake rehearsal remains
`blocked_repository_evidence_only`; it cannot assert native-driver acceptance, owner activation, platform
qualification, port/tunnel/host-key evidence, real deadlines/backpressure, native cleanup/recovery, or eligibility.

The new module is exported for review but remains absent from the local pilot and every browser, HTTP, worker, Hermes,
service, and deployment composition. It contains no networking, process, SSH, credential, provider, or runtime effect
implementation. Producer gates pass at 65/65 focused tests, 107/107 connection tests, 123/123 CR13A tests, 769/769
pretests, 419/421 core tests with two established platform skips, 358/358 posttests, TypeScript, lint, production build
with 4/4 rendered routes, macOS stage zero, all 36 migrations/119 tables through the listener-free verifier, and
whitespace. Completion requires a different independent zero-repair review with no High, Medium, or Low finding.
Acceptance permits ordinary owner-controlled integration only and grants no real listener or external-effect
authority. Use Sol xhigh.

The immutable review target is `3c756154744a1b933093771a878ab6b64f243f2e`; review packet SHA-256:
`6704782075dcb61738aeba22a122aebe82ecdef35d0ed2e373f3eed5e54d7ec7`.

The independent reviewer rejected the target with 0 High, 2 Medium, and 0 Low findings. M-001 reproduced
cross-provenance substitution among separately minted but publicly equal plan/readiness and contract/rehearsal
records. M-002 reproduced mutation of the exported driver prototype method function objects. The negative report is
preserved at `docs/reviews/CR13A_LIVE_110_INDEPENDENT_REVIEW.md`; SHA-256:
`4b2365d97aed3d7eae357c8f49499702d9e81c1552c86550554b17e433ddbc48`. Remediation must add module-private
exact-object relationship checks, freeze the three method function objects, add hostile regressions, and receive a
different zero-repair re-review before integration.

Exact remediation `565bc250d3735b2821e28fdd8c7217afdcd2990d` adds private readiness-to-plan,
contract-to-plan/readiness, rehearsal-to-contract/driver, and driver-to-contract relationships and enforces them at
contract and activation-evidence composition. It freezes the exported fake-driver class and all three prototype method
function objects. New regressions close all reproduced equal-identity substitutions and method-function mutation
paths with zero replacement executions. The complete producer gates pass at 66/66 focused tests, 108/108 connection
tests, 124/124 CR13A tests, 769/769 pretests, 419/421 core tests with two established platform skips, 359/359
posttests, TypeScript, lint, production build with 4/4 rendered routes, stage zero, migrations `0001` through `0036`
with 119 tables through the listener-free verifier, and whitespace. A different zero-repair re-review is mandatory.

A different zero-repair reviewer accepted immutable target `8643513a5ff807c9fdfa74874053b9098ac447a9`
with 0 High, 0 Medium, and 0 Low findings. M-001 and M-002 are closed. The accepted hostile evidence includes 36
copy/behavior cases, 113 individual truth replacements, 15 array mutations, 11 numeric-bound violations, 20 ambient
intrinsic attacks, 64 concurrent calls, zero replacement executions, and zero effects. Preserve the accepted report
at `docs/reviews/CR13A_LIVE_110_REMEDIATION_INDEPENDENT_REREVIEW.md`; SHA-256:
`d5a3f3adc45c2651c2592ed8cf9d390c87fa330c676b24fb55e0dc91a5c54ff0`. The branch is ready for ordinary
owner-controlled pull-request integration and grants no native or external-effect authority.

Owner-approved PR #240 merged exact accepted branch head `2978c84a07aee8566d8d3de5d02689d5d9eff609` to `main` as
`1ee5409c0b66afbd802582459af864ec0d198f5c`. Pre-merge CI run `33803032198` and post-merge `main` CI run
`33804402020` passed. LIVE-110 is integrated without adding or authorizing a physical driver, socket, listener,
network connection, SSH operation, credential read, native qualification, production contact, or deployment.

## CR13A-LIVE-120 — physical native-driver design and qualification boundary

Status: design complete; first unwired implementation rejected; exact remediation
`5a579342b7a03bb013de21663c69a3a6118e11c6` independently accepted; owner-controlled integration ready and physical
qualification remains blocked.
See `CR13A_LIVE_120_PHYSICAL_NATIVE_DRIVER_DESIGN.md`. Use Sol xhigh.

Before any `node:net` import, physical driver implementation, runtime wiring, port selection, listener operation, or
native attempt, freeze the exact operating-system boundary. The design must define literal IPv4 loopback binding,
private unpublished port custody, one active connection and zero queued connections, one bounded frame, connection,
idle, and admission deadlines, backpressure, ordered close and drain, process-restart recovery, authenticated tunnel
peer and host-key evidence, terminal ambiguity, and automatic-retry prohibition.

The design must keep implementation, activation evidence, owner authorization, platform qualification, and the one
physical attempt as non-collapsible stages. Repository tests remain fake-only and cannot clear any LIVE-110 blocker.
No socket code, live port, SSH, credential access, runtime wiring, or external effect belongs in the design block.
A later implementation requires a new immutable review target; a later physical bind requires a fresh owner-attended
one-attempt packet and exact authority.

The completed design fixes the non-collapsible implementation, activation-candidate, owner-spend, physical-observation,
independent-evidence, and runtime-activation stages; a four-component driver/locator-broker/signer/disabled-composition
split; exact private inputs; terminal lifecycle states; literal-loopback and non-authentication truth; admission,
frame, byte, chunk, backpressure, timer, cleanup, restart, ambiguity, and no-retry rules; public sanitation; the later
qualification packet; and the mandatory hostile review. It adds no native module, listener, port, connection, SSH,
credential, provider, production, or deployment path. Implementation now requires a separate exact owner grant; the
physical attempt will require another later owner-attended grant.

The owner granted the bounded implementation authority without runtime wiring or a physical attempt. Product
`959b8cbf5a5ede689fe4b8b6b3a4fc7f289efd38` adds one isolated `node:net` server-driver module. Its physical factory
and bind-capability registry are unreachable from exports, the registry has no issuer, the package barrel omits the
module, and no source consumer imports it. The shared five-operation controller is exercised only through a fixed
repository fake over closed, pre-bind-failure, post-marker-ambiguity, and cleanup-failure outcomes. All public status
records remain exact-branded, sanitized, non-authorizing, and explicit about zero listener attempts and zero network
observations.

Producer gates pass at 32/32 dedicated tests, 137/137 CR13A tests, 769/769 pretests, 372/372 core tests, 372/372
posttests, TypeScript, full lint, macOS stage zero, production build with 4/4 rendered routes, migrations through
`0036` with 119 tables via the no-IPC verifier, and whitespace. Review packet SHA-256 is
`e42cde8b401117e8bb71971315fff0219a5e8f17827e7df7a480a42ca967c9b5`. A different zero-repair review must return
0 High, 0 Medium, and 0 Low findings before integration. Even acceptance would grant no physical attempt or runtime
activation authority.

A different report-only reviewer rejected the first target with four High and five Medium findings. Exact first-socket
admission did not exist; decoder calls were replaceable; local callbacks could self-attest closed/recovered truth;
cleanup could retain decoder bytes and capability references; backpressure resumed without low-water observation;
exports remained mutable; ambient `Number` could execute and leak; the native factory used public digest equality;
and drain/final shutdown were not separate. Preserve the report at
`docs/reviews/CR13A_LIVE_120_INDEPENDENT_REVIEW.md`; SHA-256:
`baefddebe2af5bcf3f2132d2a8ef2b9bce9c84f02477fff8e95de9319b8b8e66`.

Exact remediation `5a579342b7a03bb013de21663c69a3a6118e11c6` requires a private exact-socket admission bound to
attempt, ordinal, deadline, tunnel-peer proof, and host-key proof before installing handlers. It captures/freezes
decoder and exported callables, retains exact private digests rather than re-entering ambient hashing during parsing,
requires exact contract/implementation objects, measures pending bytes across high/low watermarks, and converges every
post-marker path on decoder wipe, callback/timer removal, socket destruction, separately bounded drain/shutdown, and
capability release. Because signer, durable ledger, high-water checkpoint, and independent resource observation are
absent, physical cleanup always remains `cleanup_failed`; local truth can never produce `closed_verified`.

Remediation gates pass at 34/34 dedicated tests, 123/123 connection tests, 139/139 CR13A tests, 769/769 pretests,
372/372 core tests, 374/374 posttests, TypeScript, full lint, macOS stage zero, production build with 4/4 rendered
routes, migrations through `0036` with 119 tables via the no-IPC verifier, and whitespace. Re-review packet SHA-256 is
`28e91c4cbbd948c2636e1e1aeae19b1c27b5a113909c50fdaa50708f8c3e8dca`. Acceptance required a different zero-repair
reviewer to close all nine findings before integration. No physical attempt or runtime activation is authorized.

That different zero-repair reviewer accepted the exact remediation with 0 High, 0 Medium, and 0 Low findings. All
four original High and five Medium findings are closed. Current-run evidence passed 34/34 focused, 123/123 connection,
139/139 CR13A, 769/769 pretests, 419/421 core tests with two established Windows-only skips, 374/374 posttests,
production build with 4/4 rendered routes, migrations through `0036` with 119 tables, and an independent 3/3 hostile
probe. Hostile replacement executions, protected-byte exposures, native constructions, bind capabilities, admissions,
physical listener/socket/port attempts, network observations, and external effects were all zero. Preserve the
accepted report at `docs/reviews/CR13A_LIVE_120_REMEDIATION_INDEPENDENT_REREVIEW.md`; SHA-256:
`420e0d3313915d9a0b71cc6fa537f3742e64359186ba569021b4d3ece95e3f7c`. Ordinary owner-controlled integration is
ready. Physical qualification and runtime activation remain separate, blocked stages.

Owner-approved PR #241 merged exact accepted branch head `6f86881879d4c42bc21294eff559200aae0b439f` to `main` as
`19a87163c9210730140ec0d769c2effa6bbb5e1b`. This integration does not issue a capability or admission, construct the
native backend, open a listener/socket/port, wire runtime activation, use SSH or credentials, contact a provider or
production system, or deploy.

## CR13A-LIVE-130 — physical qualification prerequisite boundary

Status: exact effect-free implementation `339c2e8a61e7c2ac0a40fc6f51711a512badbf6c` is independently accepted and
ready for ordinary owner-controlled integration. See
`CR13A_LIVE_130_QUALIFICATION_PREREQUISITE_BOUNDARY.md`,
`CR13A_LIVE_130_QUALIFICATION_PREREQUISITE_ACCEPTANCE.md`, and ADR-164. Use Sol xhigh.

LIVE-130 must create one exact frozen readiness record that distinguishes independently accepted source from physical
qualification. It binds the exact LIVE-120 integration/remediation/review evidence, lists twelve missing private
prerequisites in fixed order, keeps every physical/effect count and authority grant false, and cannot assemble a
candidate or accept caller-supplied proof. The module imports no native driver or effectful subsystem and may expose
only safe status projection through the connection-registry barrel.

Completion requires strict exact provenance, hostile copy/accessor/symbol/Proxy and decoration tests, public
sanitation, static non-wiring, relevant and full repository gates, one immutable review packet, and a different
zero-repair reviewer with no High, Medium, or Low finding. Acceptance permits owner-controlled integration only; all
private providers, owner authorization, native qualification, and runtime activation remain later separate blocks.

The exact product passes 24/24 focused readiness tests, 131/131 connection tests, 148/148 CR13A tests, the complete
registered lifecycle, production build with 4/4 rendered routes, and migrations 0001-0036/119 tables through the
listener-free fallback. Its immutable review packet is
`docs/reviews/CR13A_LIVE_130_INDEPENDENT_REVIEW_PACKET.md`. Its first run preserved one denied reviewer-side IPC
attempt and Medium packet contradiction `CR13A-LIVE-130-PACKET-M-001`; it is not acceptance evidence. The corrected
packet `docs/reviews/CR13A_LIVE_130_REVIEW_PROTOCOL_REMEDIATION_PACKET.md` forbids `tsx` CLI probes and all broader
driver-importing test scripts, and instead requires the nine readiness tests plus listener-free static/build/migration
checks and hostile probes from a second different reviewer. The corrected review accepted the exact product with 0
High, 0 Medium, and 0 Low findings; 30 hostile attempts executed zero replacements, and all listener/IPC/native/network
and external-effect counts were zero. Preserve
`docs/reviews/CR13A_LIVE_130_PROTOCOL_REMEDIATION_REREVIEW.md`; SHA-256
`02fa96a370615a331d8ccfadaa5d9de1d2ed420eafbce60014d2b394b1283290`. These producer results and review corrections
did not construct or import the native driver and clear none of the twelve blockers.

## CR13A-LIVE-140 — target-runtime attestation boundary

Status: exact product `6e716bd77c26ad7f70343ddd687dff990f5db12f` is independently accepted on a stacked
branch and ready for ordinary owner-controlled integration. Use Sol xhigh.
See `CR13A_LIVE_140_TARGET_RUNTIME_ATTESTATION_BOUNDARY.md` and ADR-165.

LIVE-140 must define, implement with repository fakes, and independently review a privacy-preserving target-runtime
attestation port. It may describe the minimum stable claims needed to bind a future qualification candidate to one
runtime class and boot/session epoch, but it may not inspect this Mac, accept raw caller identity, read environment or
system profiles, collect host/user/path/PID/network/credential values, invoke a platform API, sign production evidence,
or clear `target_runtime_attestation_missing`.

Architecture and ADR come first. The effect-free implementation must use exact private provenance, fixed sanitized
claims, explicit expiry/replay/epoch boundaries, no production-shaped proof issuer, no clock/callback/executable input,
zero authority grants, and runtime non-wiring. A future real attestor, host observation, candidate assembly, owner
window, native qualification, and activation each remain separate blocks.

The frozen contract selects the intended macOS/Node 22 private-loopback host class, both supported Mac architecture
classes, single-boot/process/candidate/attempt binding, a 60-second future ceiling, exact required private claim names,
and a strict public privacy boundary. It explicitly rejects raw or unsalted host identifiers. This block implements
only one exact policy singleton and one `repository_fake` singleton with every real observation, proof, blocker-clearance,
authority, and effect field false or zero.

The exact product passes 9/9 dedicated tests, 140/140 connection tests, 157/157 CR13A tests, the complete lifecycle,
production build with 4/4 rendered routes, and migrations 0001-0036/119 tables. The readiness-only independent packet
is `docs/reviews/CR13A_LIVE_140_INDEPENDENT_REVIEW_PACKET.md`. It forbids broad driver-importing tests, `tsx` CLI/version
probes, host observation, and every native/external effect.

The first reviewer passed all eleven fixed gates but bare `--import tsx` from its out-of-tree hostile entrypoint could
not resolve the package and exited before product import. It correctly stopped without retry. Preserve the rejected
report at `docs/reviews/CR13A_LIVE_140_INDEPENDENT_REVIEW.md`; SHA-256
`6eb5f26004c17a10e7545da8f321e704c5e5c01da0c924fd706ca4bd64803688`. The corrected packet
`docs/reviews/CR13A_LIVE_140_REVIEW_PROTOCOL_REMEDIATION_PACKET.md` pins the prevalidated explicit loader
`./node_modules/tsx/dist/loader.mjs` for one new reviewer's single out-of-tree invocation; product remains unchanged.

Later report-only reviews preserved a guessed-path stop, a `.ts` module-format stop, and a redundant issuer-check false
positive without changing the product. The final packet binds committed hostile helper SHA-256
`ded101e5d21d78efe5aeceb0ea647bb22469b3430ffb45a06126bd5c1556d60b`. A fifth different reviewer passed all 16
exact commands, all twelve hostile groups, 63 hostile attempts and eight replacement attempts with zero executions,
and every forbidden-effect count at zero. Preserve
`docs/reviews/CR13A_LIVE_140_FINAL_INDEPENDENT_REVIEW.md`; SHA-256
`483ab05695b5cecaa6fe02ca4cc63b2e640733ac42270e2a435364c6be0ea6d8`. This accepts only effect-free integration;
the target-runtime blocker remains missing.

## CR13A-LIVE-150 — private locator broker boundary

Status: exact product `f089f896073fcc5aab24616a17fac592eba5146b` independently accepted on a stacked branch;
ordinary owner-controlled integration ready. Use Sol xhigh.

LIVE-150 must freeze one opaque, one-use private locator-broker boundary before any literal loopback address or port is
selected. It may implement exact repository contracts, a non-production fake, strict provenance parsers, hostile
tests, and status projection only. It must not read or select a host address, enumerate interfaces, reserve a port,
construct a socket/listener, issue or spend a capability, expose a locator, contact a provider, or wire runtime use.

The fake must retain `private_locator_broker_missing` and `exclusive_port_custody_missing`, keep every issuance/spend/
selection/native/network/effect count at zero, grant no authority, and remain structurally impossible to relabel as a
real private locator. Architecture, product verification, and a different independent review are required before
ordinary owner-controlled integration.

Producer verification passes 9/9 dedicated, 149/149 connection, 166/166 CR13A, the complete lifecycle, 5/5 build
phases, 4/4 rendered pages, migrations 0001-0036/119 tables, TypeScript, lint, stage zero, and whitespace. A different
reviewer passed all twelve exact commands and twelve hostile groups with 0 High/Medium/Low. Sixteen direct hostile
cases and four ambient replacements executed zero behavior; every forbidden-effect count remained zero. Preserve
`docs/reviews/CR13A_LIVE_150_INDEPENDENT_REVIEW.md`; SHA-256
`e7047c506fad1f969563d3bb1ae31df28083761b2470bc322a91c4aa733abd67`. No locator, port, reservation, capability,
blocker clearance, or runtime authority exists.

## CR13A-LIVE-160 — exclusive port custody boundary

Status: exact product `97d46c74e413d21c1f81c9704b9eb0b66447be5c` independently accepted on a stacked branch;
ordinary owner-controlled integration ready. Use Sol xhigh.

LIVE-160 must define an operating-system-backed exclusive port reservation/custody port before any selection or
reservation occurs. The repository block may add only an exact policy, non-production fake, strict parser, hostile
tests, and safe status projection. It must expose no literal port/address or reservation handle, perform no
interface/DNS/port/socket/listener/timer operation, issue no locator capability, clear no blocker, and wire no runtime
consumer. A later real provider and its physical reservation attempt remain separate owner-attended work.

Producer verification passes 8/8 dedicated, 157/157 connection, 174/174 CR13A, the complete lifecycle, 5/5 build
phases, 4/4 rendered pages, migrations 0001-0036/119 tables, TypeScript, lint, stage zero, and whitespace. A different
reviewer passed all twelve fixed commands and review groups with 0 High/Medium/Low. Fifteen direct hostile cases and
four ambient replacements executed zero behavior; every forbidden-effect count remained zero. Preserve
`docs/reviews/CR13A_LIVE_160_INDEPENDENT_REVIEW.md`; SHA-256
`0a0837acbd36ba9292e8b3f37b57d4900290aa03c54c3c13c73413aebd8345a6`. The accepted result honestly retains the
driver-handoff gap and clears no blocker.

## CR13A-LIVE-170 — physical-driver retained-resource handoff boundary

Status: exact product `7e76e1980541075f9a1fa45479d20f06a823ef29` independently accepted on a stacked branch;
ordinary owner-controlled integration ready. Use Sol xhigh.

LIVE-170 must freeze the exact one-use handoff seam by which a future private custody provider transfers the same
already-retained operating-system resource into the physical driver. It may add only the contract, strict provenance
and parser boundaries, a non-production fake, hostile tests, and safe status projection. It must not create, bind,
listen on, inspect, close, duplicate, serialize, or expose a native resource; select or publish an address/port; import
or call a native backend; wire a runtime consumer; clear either locator/custody blocker; or authorize a physical attempt.

The handoff must be atomic and single-use, preserve resource identity and continuous custody, reject raw numbers and
caller-built handles, define terminal cleanup under failure or uncertainty, and make retry/rebind/reopen impossible.
Only after immutable producer evidence and a different independent zero-repair review may a later owner-attended block
implement or exercise the native side.

Producer verification passes 8/8 dedicated, 165/165 connection, 182/182 CR13A, the complete lifecycle, 5/5 build
phases, 4/4 rendered pages, migrations 0001-0036/119 tables, TypeScript, lint, stage zero, and whitespace. A different
reviewer passed all twelve commands and groups with 0 High/Medium/Low. Fifteen direct hostile cases and four ambient
replacements executed zero behavior; every forbidden-effect count remained zero. Preserve
`docs/reviews/CR13A_LIVE_170_INDEPENDENT_REVIEW.md`; SHA-256
`3581dcf33774e730614346d57594738236acf0932fa581214af7931af67c1381`. The driver handoff and custody blockers remain.

## CR13A-LIVE-180 — unwired retained-resource driver port

Status: exact product `052afc3b4a61f1c6f1957a567f5305f3a2c5bca0` independently accepted; ordinary owner-
controlled integration ready. Use Sol xhigh.

LIVE-180 may implement a module-private one-use acceptance and cleanup state machine that can later receive the exact
retained resource described by LIVE-170. Repository fakes must prove identity continuity, one acceptance, serialized
settlement, terminal ambiguity, mandatory cleanup, and no replacement bind or retry. No real resource may be created,
bound, listened on, inspected, transferred, or closed; no address/port/handle may escape; and no runtime consumer,
qualification candidate, physical attempt, blocker clearance, or activation authority may exist.

Producer verification passes 10/10 dedicated, 176/176 connection, 192/192 CR13A, the complete lifecycle, 5/5 build
phases, 4/4 rendered pages, migrations 0001-0036/119 tables, TypeScript, lint, stage zero, and whitespace. The first
review passed every product gate but invalidated itself with one extra wrong-commit inspection and is preserved. A
second different reviewer passed all twelve fixed commands and review groups with 0 High/Medium/Low; twelve hostile
attempts and six ambient replacements executed zero behavior; every forbidden-effect count remained zero. Preserve
`docs/reviews/CR13A_LIVE_180_INDEPENDENT_REREVIEW.md`; SHA-256
`05c4d57ad9f247916102acdc090c071b22a9b7a9623d1984779caf41d8acfd76`. A later separately authorized owner-attended
block is required for any real native attempt.

## CR13A-LIVE-190 — unwired native retained-resource adapter boundary

Status: exact remediated product `d59c02792e49a79a291e3f9109fc43f2fd22fbd8` independently accepted; ordinary
owner-controlled integration ready. Use Sol xhigh.

LIVE-190 may define the module-private adapter seam by which the accepted physical driver can later consume the same
already-retained native server instead of selecting a numeric port and binding a replacement. The block may add exact
contracts, a repository fake, provenance parsers, state/cleanup policy, hostile tests, and a safe status projection.
It may refer to the existing allowlisted native server type inside the isolated physical-driver boundary, but all
repository verification must remain fake-only.

The block must not create, bind, listen on, inspect, transfer, or close a real resource; select or expose an address or
port; export a native handle/capability/factory; issue or spend a live handoff; wire any app, API, worker, Idea Lab,
Hermes, startup, or production consumer; clear locator/custody/qualification blockers; assemble a candidate; or make a
physical attempt. Immutable producer evidence and a different independent zero-repair review are required before
ordinary integration.

Producer verification passes 11/11 dedicated, 26/26 focused native-boundary, 187/187 connection, 203/203 CR13A, the
complete lifecycle, 5/5 build phases, 4/4 rendered pages, migrations 0001-0036/119 tables, TypeScript, lint, stage zero,
and whitespace. The first reviewer preserved one Low trailing-blank-line rejection and stopped correctly. A different
rereviewer passed all twelve fixed commands and groups with 0 High/Medium/Low; hostile and ambient replacement inputs
executed zero behavior; every forbidden effect and authority remained zero or false. Preserve
`docs/reviews/CR13A_LIVE_190_REMEDIATION_INDEPENDENT_REREVIEW.md`; SHA-256
`29be3e4ba7075397a764d57161bbff953993e6d2d815a4cc9ac353f475ab224a`.

## CR13A-LIVE-200 — private native retained-resource issuer contract

Status: exact product `9e3cb2afdcd3008dcdac94d113db991f34e49175` independently accepted; ordinary owner-controlled
integration ready. Use Sol xhigh.

LIVE-200 may freeze the module-private issuer contract that will later create and retain one native server and transfer
that exact resource through the accepted LIVE-170 handoff, LIVE-180 driver port, and LIVE-190 adapter. Repository work
must remain fake-only and may define strict private candidate, attempt, epoch, owner-window, custody, locator-capability,
target-runtime, tunnel-peer, host-key, deadline, spend, checkpoint, failure, cleanup, and safe-evidence bindings.

The block must not create, bind, listen on, inspect, transfer, or close a real server; select, reserve, reveal, or consume
a real address or port; import or call a runtime native backend; issue or spend live authority; read protected values;
wire an application, API, worker, Idea Lab, Hermes, startup, or production consumer; assemble a live qualification
candidate; make a physical attempt; contact a provider; or deploy. Immutable producer evidence and a different
independent zero-repair review are required before ordinary integration.

Producer verification passes 9/9 dedicated, 196/196 connection, 212/212 CR13A, the complete lifecycle, 5/5 build
phases, 4/4 rendered pages, migrations 0001-0036/119 tables, TypeScript, lint, stage zero, and whitespace. A different
reviewer passed all twelve commands and groups with 0 High/Medium/Low. Five hostile parser attempts, nine callable-
shadowing attempts, and four ambient replacements executed zero behavior; every forbidden effect and authority remained
zero or false. Preserve `docs/reviews/CR13A_LIVE_200_INDEPENDENT_REVIEW.md`; SHA-256
`82caf0b6ffc0a66661448a9780d0557221faa179f43956d6b2f691a7a1404185`.

## CR13A-LIVE-210 — unwired private native issuer state machine

Status: exact product `c4cac41561214117161c9764604f5dc06ecd63b6` independently accepted; ordinary owner-controlled
integration ready. Use Sol xhigh.

LIVE-210 may implement a repository-only fake state machine behind the accepted LIVE-200 contract. It must model one
private attempt from verified/claimed pre-effect state through uncertainty, fake resource retention, exact fake adapter
acceptance, ownership transfer, mandatory cleanup, cleanup failure, and no-reopen recovery. It must serialize operations,
preserve promise identity, distinguish definite failure from post-marker ambiguity, and expose only safe negative truth.

The block must not import a runtime network module; create, receive, inspect, transfer, or close a real server; select or
reveal an address or port; issue or spend live authority; write live persistence; call the accepted native adapter or
physical driver; wire any runtime consumer; assemble a candidate; make a physical attempt; contact a provider; or deploy.
Immutable producer evidence and a different independent zero-repair review remain required.

Producer verification passes 11/11 dedicated, 207/207 connection, 223/223 CR13A, the complete lifecycle, all five
build phases, 4/4 rendered pages, migrations 0001-0036/119 tables, TypeScript, lint, stage zero, and whitespace. A
different reviewer passed all twelve commands and groups with 0 High/Medium/Low. Eleven hostile/misuse assertions and
six ambient replacements executed zero behavior; every real effect and authority remained zero or false. Preserve
`docs/reviews/CR13A_LIVE_210_INDEPENDENT_REVIEW.md`; SHA-256
`c25e22dfa2c8601b23547a8a6f32b68d78da23458a696cd9461678ce084ec2c7`.

## CR13A-LIVE-220 — unwired native issuer implementation boundary

Status: exact product `2e9a2cb9ed65dd13e4653fecab4b94ca707c10b9` independently accepted; ordinary integration of
unreachable code ready. Use Sol xhigh.

LIVE-220 may define one isolated native issuer backend behind the accepted LIVE-210 state machine and test it only with
injected fake outcomes. It must retain the exact one-attempt, one-resource, same-object custody, transfer, ambiguity,
cleanup, and no-reopen rules. The native backend must remain unreachable from every application and production runtime.

The block must not execute a real create/bind/listen/inspect/close operation; select, reserve, consume, or expose a real
port or locator; write live persistence; install handlers; wire an API, worker, Idea Lab, Hermes, startup, or production
consumer; clear a blocker; assemble a live candidate; contact a provider; deploy; or make a physical attempt. Any later
physical attempt requires a separately frozen packet and fresh exact owner-attended authorization.

Producer verification passes 12/12 dedicated, 15/15 inherited native-isolation, 219/219 connection, 235/235 CR13A,
the complete lifecycle, all five build phases, 4/4 rendered pages, migrations 0001-0036/119 tables, TypeScript, lint,
macOS stage zero, and whitespace. A different independent reviewer passed all twelve commands and review groups with
0 High/Medium/Low and 27/27 focused tests. The private factory is never retrieved or exported; every native, listener,
network, persistence, protected-read, wiring, effect, blocker, and authority value remains zero or false. Preserve
`docs/reviews/CR13A_LIVE_220_INDEPENDENT_REVIEW.md`; SHA-256
`4ced5f64ebe99bd63b3bc68295a821f0b391126630206335dd9cabf698072d30`.

## CR13A-LIVE-230 — private native issuer composition contract

Status: exact product `3974f165f106cb0fe616b2f0e91a18e45b1b4c2d` independently accepted; ordinary integration
ready. Use Sol xhigh.

LIVE-230 may freeze the exact private composition by which accepted LIVE-200 binding/spend evidence and the LIVE-210
one-use state machine could later unlock the LIVE-220 private native factory and hand the same retained server to the
accepted LIVE-190 adapter. It must specify durable claim/effect-marker ordering, private locator observation, continuous
custody, exact-object transfer, ambiguity, cleanup, and no-reopen recovery without implementing a live composition.

The block must not retrieve or invoke the private factory; create, listen on, inspect, transfer, or close a real server;
observe, select, reserve, consume, or expose a locator; issue or spend live authority; write live persistence; call the
adapter or physical driver; wire an app, API, worker, Idea Lab, Hermes, startup, or production consumer; clear a blocker;
assemble a candidate; contact a provider; deploy; or make a physical attempt. Immutable producer evidence and a
different independent zero-repair review are required before ordinary integration.

Producer verification passes 10/10 dedicated, 245/245 CR13A, the complete lifecycle, all five build phases, 4/4
rendered pages, migrations 0001-0036/119 tables, TypeScript, lint, macOS stage zero, and whitespace. A different
reviewer passed all twelve commands and review groups with 0 High/Medium/Low. Hostile, ambient replacement,
extra-argument, and callback executions remained zero; every real effect and authority remained zero or false.
Preserve `docs/reviews/CR13A_LIVE_230_INDEPENDENT_REVIEW.md`; SHA-256
`eb6957f2f577b77ce7c68fb2f8e92e80004a987e3fa83ba1bdee993f6f59d58a`.

## CR13A-LIVE-240 — unreachable private issuer composition implementation

Status: exact product `71e4c737b6e681fe24d730decc3497d196cf441c` independently accepted; ordinary integration
ready. Use Sol xhigh.

LIVE-240 may implement the accepted LIVE-230 ordering as one private, unreachable composition with injected inert
ports and opaque fake resources. It must prove durable claim/spend/uncertainty order, single factory retrieval, exact
resource custody, atomic same-object adapter transfer, cleanup ownership, ambiguity, and no-reopen recovery without
importing LIVE-220, `node:net`, a real persistence client, or any production adapter.

The block must not retrieve or invoke the real private factory; create, listen on, inspect, transfer, or close a real
server; observe, select, reserve, consume, or expose a locator; issue or spend live authority; write live persistence;
call LIVE-190 or the physical driver; wire an app, API, worker, Idea Lab, Hermes, startup, or production consumer; clear
a blocker; assemble a candidate; contact a provider; deploy; or make a physical attempt. Immutable producer evidence
and a different independent zero-repair review are required before ordinary integration.

Producer verification passes 10/10 dedicated, 255/255 CR13A, the complete lifecycle, all five build phases, 4/4
rendered pages, migrations 0001-0036/119 tables, TypeScript, lint, macOS stage zero, and whitespace. A seventh different
reviewer closed M-001 through M-006 and the companion constructor surface with 0 High/Medium/Low. Every native,
listener, network, persistence, protected-read, wiring, blocker, and authority value remains zero or false. Preserve
`docs/reviews/CR13A_LIVE_240_INDEPENDENT_SIXTH_REREVIEW.md`; SHA-256
`1d552ac7d580d6996b5192139dee85beb4f15e1058cf2c19719e9424f82f00f8`.

## CR13A-LIVE-250 — private one-use native-factory retrieval bridge contract

Status: exact product `9b855d4193837fdf6d0d0fce1dcfd65a94cce49f` independently accepted; ordinary integration
ready. Use Sol xhigh.

LIVE-250 may freeze the exact same-module, non-exported bridge by which accepted LIVE-240 prerequisite and durable
marker evidence could later permit one retrieval of the quarantined LIVE-220 factory. It must define exact product and
review binding, consumption order, one-use identity, non-serialization, failure before retrieval, ambiguity after
retrieval, and restart behavior without implementing or exercising the bridge.

The block must not expose, retrieve, return, invoke, copy, serialize, or test the real factory; modify its captured
native primitives; import a new native/effect module; create, listen on, inspect, transfer, or close a real server;
observe or expose a locator; issue or spend live authority; write live persistence; call LIVE-190 or the physical
driver; wire an app, API, worker, Idea Lab, Hermes, startup, or production consumer; clear a blocker; make a physical
attempt; contact a provider; or deploy. Immutable fake evidence and a different independent zero-repair review are
required before ordinary integration.

Producer verification passed 8/8 dedicated, 263/263 CR13A, the complete lifecycle, all five build phases, 4/4
rendered pages, migrations 0001-0036/119 tables, TypeScript, lint, macOS stage zero, and whitespace. A different
report-only reviewer ran all twelve commands exactly once with 0 High/Medium/Low and zero real effects. Preserve
`docs/reviews/CR13A_LIVE_250_INDEPENDENT_REVIEW.md`; SHA-256
`2dcb825f522345c214064ded31134e00fecbfee9aa2121a65d507398081eaca6`.

## CR13A-LIVE-260 — private same-module native-composition shell contract

Status: exact product `01bfa6540cc83dc6099564e4fc9043be4cafddc6` independently accepted; ordinary integration
ready. Use Sol xhigh.

LIVE-260 may freeze an inert contract for the future private native-composition shell that must live in the same source
module as LIVE-220 factory custody. It must define the exact internal call graph, exact accepted LIVE-250 binding,
module-owned identities, no-input/non-export rules, consumption and invocation separation, continuous custody,
failure/ambiguity semantics, restart reconciliation, safe evidence, and all remaining blockers.

The block must not modify or import LIVE-220/LIVE-240; implement or exercise the bridge or shell; expose, retrieve,
return, invoke, serialize, or test the real factory; import a new native/effect module; create, listen on, inspect,
transfer, or close a real resource; observe or expose a locator; issue or spend live authority; write live persistence;
wire runtime use; clear a blocker; assemble a candidate; make a physical attempt; contact a provider; or deploy.
Immutable repository evidence and a different independent zero-repair review are required before ordinary integration.

Producer verification passed 8/8 dedicated, 271/271 CR13A, 769/769 pretests, 392/392 core tests, 392/392 posttests,
all five build phases, 4/4 rendered routes, migrations 0001-0036/119 tables, TypeScript, lint, macOS stage zero, and
whitespace. A different report-only reviewer ran all twelve commands exactly once with 0 High/Medium/Low, zero hostile
or ambient execution, twenty zero actual totals, eight false authority grants, and no real effects. Preserve
`docs/reviews/CR13A_LIVE_260_INDEPENDENT_REVIEW.md`; SHA-256
`41c55ae9437f8951e18f919ec1569bbebe1f795cafeaade51a41826fc3d0f9f1`.

## CR13A-LIVE-270 — unreachable same-module native-composition shell implementation

Status: architecture frozen; implementation begins only after accepted LIVE-260 integration. Use Sol xhigh.

LIVE-270 may implement the accepted shell and one-use retrieval bridge only in the LIVE-220 module that already owns
the quarantined factory WeakMap. Both remain non-exported, no-input, runtime-unwired, and uninvoked. The factory may
become lexically reachable only inside the private shell, while every public actual retrieval/invocation/effect count
remains zero and native invocation remains disabled.

The block must not invoke any native primitive; create, bind, listen on, inspect, retain, transfer, or close a real
resource; observe or expose a locator; accept caller data or callbacks; import LIVE-240 or a new native module; write
live persistence; call an adapter or driver; wire app/API/worker/Idea Lab/Hermes/startup use; assemble a candidate;
perform a physical attempt; contact a provider; clear a blocker; or deploy. Immutable producer evidence and a different
independent report-only zero-repair review are required before ordinary integration.

Accepted product `5e5384b1c7b3806a62672018843aa318b0e75728` passed 33/33 dedicated review tests, 276/276
CR13A tests, the complete registered lifecycle, all five build phases, 4/4 rendered routes, migrations 0001-0036/119
tables, TypeScript, lint, macOS stage zero, and whitespace. A different report-only reviewer ran all twelve fixed
commands once with 0 High/Medium/Low, zero shell retrieval, and zero native/listener/network effects. Accepted report
SHA-256: `96edcc2c9c65ea38b3da1adec7c092fdf056e544f02856705e93ce0f19d79609`.

## CR13A-LIVE-280 — private physical-qualification candidate contract

Status: architecture frozen; effect-free implementation begins only after accepted LIVE-270 integration. Use Sol
xhigh.

LIVE-280 freezes one inert repository contract that binds the accepted LIVE-270 source, exact future real component
classes, fourteen remaining blockers, ten non-collapsible stages, one-attempt ceilings, sanitation, private provenance,
and no-retry-after-uncertainty rules. It may export only exact frozen safe contract and status records plus parsers.

The block must not import the native driver or issuer, retrieve the private shell, invoke a factory or native primitive,
assemble a qualification candidate, implement or call a real provider, create an owner window, select or observe a
locator, create/listen/inspect/transfer/close a resource, write live persistence, perform a physical attempt, wire an
app/API/worker/Idea Lab/Hermes/startup consumer, contact a provider, clear a blocker, or deploy. Immutable producer
evidence and a different independent report-only zero-repair review are required before ordinary integration.

Accepted product `c1743b7f7b5c8362cec3d33b149e3f51c5e5fda6` passed 10/10 dedicated, 286/286 CR13A,
the complete 769/392/392 lifecycle, all five build phases, 4/4 rendered routes, migrations 0001-0036/119 tables,
TypeScript, lint, macOS stage zero, and whitespace. The original procedural rejection is preserved. A different fresh
reviewer passed all twelve inspection groups and fourteen corrected commands once with 0 High/Medium/Low and zero
external effects. Accepted rereview SHA-256:
`bd8281cf4e0336eba7f55de2b8cde9e39e9305860a2a8287e3dcf74af52d7853`.

## CR13A-LIVE-290 — unreachable native target-runtime observer

Status: exact product `3d09b2b9287b1174a3e7ebe931bc2860a5ce2bba` independently accepted; ordinary integration
of unreachable source ready. Use Sol xhigh.

LIVE-290 may implement one real no-input native observer source in a dedicated module outside the safe barrel. It may
capture the minimum `node:os` operations and process-field reads needed for a later private target-runtime attestation,
create one frozen observer, and store it once in a private WeakMap with no lookup operation. Public module evidence may
state only implementation presence and zero use/effects.

The block must not invoke the observer; read host, process, environment, path, clock, locator, credential, or provider
values; return, log, serialize, persist, digest, sign, or expose raw observation; implement nonce/replay/candidate/owner
composition; retrieve the native shell; open a listener; wire any production consumer; clear the target-runtime blocker;
contact Hermes/provider; or deploy. Immutable producer evidence and a different independent report-only zero-repair
review are required before ordinary integration.

Producer verification passed 10/10 dedicated, 296/296 CR13A, the complete 769/392/392 lifecycle, all five build
phases, 4/4 rendered routes, migrations 0001-0036/119 tables, TypeScript, lint, macOS stage zero, and whitespace. A
different report-only reviewer ran all fourteen commands once with 0 High/Medium/Low, zero observer lookup or
invocation, zero host/process/path reads, zero hostile execution, and zero external effects. The review preserves a
mandatory future boundary against ambient process replacement, getters, and proxies before any observer use. Preserve
`docs/reviews/CR13A_LIVE_290_INDEPENDENT_REVIEW.md`; SHA-256
`df2f3fb2fd414d595f020395dfc69fde2857c413e82d8d206383e66c6555c9b6`.

## CR13A-LIVE-300 — private target-runtime observation trust contract

Status: exact product `aca7b98405fd12163b74fbc949a6a671d69fe310` independently accepted; ordinary integration
of the inert contract ready. Use Sol xhigh.

LIVE-300 may implement a strict safe contract fixing the future fail-closed boundary for trusted native sources,
descriptor validation, one private raw observation, observation-versus-attestation separation, one-use and uncertainty
rules, non-collapsible stages, replay binding, and public sanitation. It may export only frozen safe records and strict
parsers.

The block must not import, retrieve, or invoke LIVE-290; import `node:os` or `node:process`; read host, process,
environment, path, clock, nonce, credential, locator, or provider values; implement trusted binding capture; create,
digest, sign, persist, or expose an observation; retrieve the native shell; open a listener; wire a runtime consumer;
clear a blocker; contact Hermes/provider; perform a physical attempt; or deploy. Immutable producer evidence and a
different independent report-only zero-repair review are required before ordinary integration.

Producer verification passed 10/10 dedicated, 306/306 CR13A, the complete 769/392/392 lifecycle, all five build
phases, 4/4 rendered routes, migrations 0001-0036/119 tables, TypeScript, lint, macOS stage zero, and whitespace. A
different reviewer ran all fourteen commands once with 0 High/Medium/Low, zero hostile behavior, and zero native,
observation, network, persistence, provider, or external effects. Preserve
`docs/reviews/CR13A_LIVE_300_INDEPENDENT_REVIEW.md`; SHA-256
`86721e47c4c3c743aee97d5c577a1701242f799fdf6063c3dfbcfd3997d1758e`.

## CR13A-LIVE-310 — unreachable trusted native-binding validator

Status: corrected exact product `d95738bf79f9f12f6986f28b8f7548b661f0587a` independently accepted after a
third different review. Use Sol xhigh.

LIVE-310 may statically import one `node:process` module namespace, define one private frozen no-input descriptor
validator, and store it once in a private WeakMap with no lookup. Property access and descriptor inspection may exist
only inside the unreachable validator body. Fixed public records may state source presence and zero use/effects.

The block must not invoke the validator; inspect a descriptor; read a process/environment/path value; import or compose
LIVE-290; return a native binding; create an observation, attestation, nonce, replay checkpoint, signature, or
candidate; retrieve the native shell; open a listener; wire runtime use; clear a blocker; contact Hermes/provider;
perform a physical attempt; or deploy. Immutable producer evidence and a different independent report-only zero-repair
review are required before ordinary integration.

Producer verification passed 12/12 dedicated tests, 318/318 CR13A tests, the complete 769/421/392 lifecycle, all five
build phases, 4/4 rendered routes, migrations 0001-0036/119 tables, TypeScript, lint, macOS stage zero, whitespace, and
clean status. The first review's two Medium findings and first re-review's one Low finding remain preserved. A third
different reviewer closed M-001, M-002, and L-001 and passed all twelve groups and fourteen commands exactly once with
0 High/Medium/Low and zero validator, descriptor, process, observer, native, network, or external effects. Preserve
`docs/reviews/CR13A_LIVE_310_INDEPENDENT_SECOND_REREVIEW.md`; SHA-256
`db3c721a2ad20b9f533202bc48275df6617035d30eb27df52900d8f97dbdb20e`.

## CR13A-LIVE-320 — private atomic native-observation composition contract

Status: exact product `0c906419652adceb5e771637ae269b52fd1c77cd` independently accepted; ordinary integration
of the inert contract ready. Use Sol xhigh.

LIVE-320 may freeze one inert exact contract for the future same-module composition of LIVE-290 observation operations
and LIVE-310 binding validation. The future routine must remain private, no-input, synchronous, and unreachable; validate
the exact four process namespace data descriptors; consume only those already validated descriptor values; call only
the statically selected minimum OS operations; and return at most one private frozen raw observation. Validation and
consumption cannot be separated by a callback, `await`, timer, caller input, second namespace read, or exported
capability.

The block must not import or modify LIVE-290/LIVE-310; import `node:process`, `node:os`, or another native/effect module;
implement, retrieve, or invoke the future composition; inspect a descriptor; read a process, OS, host, path,
environment, clock, credential, locator, or provider value; create a raw observation or attestation; implement a signer,
nonce, replay checkpoint, candidate, owner window, or persistence port; retrieve the native shell; open a listener;
wire runtime use; clear a blocker; contact a provider; perform a physical attempt; or deploy. Immutable producer
evidence and a different independent report-only zero-repair review are required before ordinary integration.

Producer verification passed 10/10 dedicated tests, 328/328 CR13A tests, the complete 769/421/392 lifecycle, all five
build phases, 4/4 rendered routes, migrations 0001-0036/119 tables, TypeScript, lint, macOS stage zero, whitespace, and
clean status. A fresh different reviewer passed all twelve groups and fourteen commands exactly once with
0 High/Medium/Low, exact four-path scope, verified disposable cleanup, and zero native, descriptor, process, OS, host,
network, provider, or external effects. Preserve `docs/reviews/CR13A_LIVE_320_INDEPENDENT_REVIEW.md`; SHA-256
`da7d247d874d543877c18215ae9e8fbbba7ba838065fe6a9d410772e776799d6`.

## CR13A-LIVE-330 — unreachable atomic native-observation source consolidation

Status: exact product `06be655d188c45902c015f85225673dfc31c445d` independently accepted; ordinary integration
of the unreachable source ready. Use Sol xhigh.

LIVE-330 may add one dedicated private module with one statically selected `node:process` namespace and the exact
`node:os` platform, architecture, release, and uptime callables. One frozen no-input synchronous function may contain
the exact descriptor validation, direct descriptor-value consumption, OS result validation, and private frozen
observation construction required by LIVE-320. It must be stored exactly once in a module-private WeakMap with no
lookup, export, invocation, or consumer.

The block must not import or modify the historical LIVE-290/LIVE-310 private modules; read any native value during
module initialization or tests; export/retrieve/invoke the function; inspect a descriptor; expose, digest, log,
serialize, persist, sign, or use an observation; implement clock, nonce, replay, candidate, owner, listener, runtime,
provider, or deployment behavior; clear a blocker; perform a physical attempt; or touch production state. Immutable
producer evidence and a different independent report-only zero-repair review are required before ordinary integration.

Producer verification passed 11/11 dedicated tests, 339/339 CR13A tests, the complete 769/421/392 lifecycle, all five
build phases, 4/4 rendered routes, migrations 0001-0036/119 tables, TypeScript, lint, macOS stage zero, whitespace, and
clean status. A fresh different reviewer passed all twelve groups and fourteen commands exactly once with
0 High/Medium/Low, exact three-path scope, verified disposable cleanup, and zero source lookup/invocation, descriptor,
process, OS, host, network, provider, or external effects. Preserve
`docs/reviews/CR13A_LIVE_330_INDEPENDENT_REVIEW.md`; SHA-256
`da2c7529b8a5e023b706df8e6ab912e2096c2742edfda0e74758991721031f85`.

## CR13A-LIVE-340 — private one-use native-observation invocation contract

Status: exact product `3108a8759863c4692ade2d5532e88cd28f259779` independently accepted; ordinary integration
of the inert contract ready. Use Sol xhigh.

LIVE-340 may freeze one inert exact contract for a future authenticated one-use authorization to retrieve and invoke
the LIVE-330 source inside the same private module. The contract must bind implementation identity, tenant/project/
connection/node/candidate/attempt lineage, platform/runtime, one operation, fresh nonce, trusted time, atomic
pre-lookup consumption, replay, post-transaction time recheck, terminal ambiguity, and raw-value privacy. It may export
only immutable safe contract/status records, fixed rule/stage/blocker/outcome arrays, strict parsers, and safe errors.

The block must not import or modify LIVE-330 or any native/effect module; create an authorization store, key, token,
clock, nonce, checkpoint, spend, bridge, lookup, or invocation; inspect a descriptor; read or use native values; create
an observation or attestation; persist anything; implement candidate/owner/listener/runtime/provider/deployment
behavior; clear a blocker; perform a physical attempt; or touch production state. Immutable producer evidence and a
different independent report-only zero-repair review are required before ordinary integration.

Producer verification passed 11/11 dedicated tests, 350/350 CR13A tests, the complete 769/421/392 lifecycle, all five
build phases, 4/4 rendered routes, migrations 0001-0036/119 tables, TypeScript, lint, macOS stage zero, whitespace, and
clean status. A fresh different reviewer passed all twelve groups and fourteen commands exactly once with
0 High/Medium/Low, exact four-path scope, verified disposable cleanup, and zero authorization, replay, spend, lookup,
invocation, native-read, observation, persistence, network, provider, or external effects. Preserve
`docs/reviews/CR13A_LIVE_340_INDEPENDENT_REVIEW.md`; SHA-256
`bbe5b2bc027ad0d71838ab1784ed1081750ffb96eba9ae1b26fd162b6a9234af`.

## CR13A-LIVE-350 — authenticated invocation-authorization store

Status: architecture frozen; PostgreSQL-compatible repository implementation may proceed on accepted LIVE-340. Use
Sol xhigh.

LIVE-350 may add one immutable authenticated registration store through the existing `DatabaseClient`, one migration,
and local PGlite tests. It accepts an already sealed exact authorization body, captures a separately supplied
protected HMAC key, and atomically inserts the authorization plus a tenant-scoped digest-only nonce reservation. Exact
replay is inert; changed authorization-ID or nonce reuse fails closed. The store returns only sanitized registration
evidence and cannot issue, consume, revoke, list, or expose an authorization.

The block must not import or modify LIVE-330; import a native/effect module; generate or read a production key; treat
caller time as trusted current time; consume an authorization; add a source lookup/invocation; inspect a descriptor;
read or expose native material; create an observation/attestation/candidate/owner authorization; open a listener; wire
application/runtime/provider use; connect to production PostgreSQL; deploy; or claim PGlite as production evidence.
Immutable producer evidence and a different independent report-only zero-repair review are required before ordinary
integration.

Producer verification passed 14/14 dedicated tests, 364/364 CR13A tests, the complete 769/421/392 lifecycle, all five
build phases, 4/4 rendered routes, migrations 0001-0037/122 tables, TypeScript, lint, macOS stage zero, whitespace, and
clean status. The first independent review's one Medium key-separation finding is preserved. Corrected product
`053c4d02003e0223438e26aecea851253d05a60b` rejects identical authorization/state key bytes before database work. A
second different reviewer passed all ten groups and fourteen commands exactly once with 0 residual High/Medium/Low and
zero consumption, source lookup/invocation, native, network, production-database, provider, or external effects.
Preserve `docs/reviews/CR13A_LIVE_350_INDEPENDENT_REREVIEW.md`; SHA-256
`ffea24f4ed6e7d62ffb7a06caf2446471582eff6780351af88136b9aba3c3324`.

## CR13A-LIVE-360 — trusted database-time and lineage validation

Status: architecture frozen; read-only repository implementation may proceed on accepted corrected LIVE-350. Use Sol
xhigh.

LIVE-360 may extend the authorization store with one exact read-only pre-consumption validator. Inside one transaction,
it must authenticate the complete stream/head and digest-only nonce reservation, require an exact sealed authorization
and full lineage match, then read `clock_timestamp()` from the same database session. It passes only at or after
not-before and strictly before expiry and returns immutable sanitized `validated_unconsumed` evidence.

The block must not add a migration; accept caller time/callables; issue, consume, revoke, update, delete, or list an
authorization; import/modify/retrieve/invoke LIVE-330; inspect a descriptor; read/expose protected native material;
create an observation/attestation/candidate/owner authorization; open a listener; wire application/runtime/provider
use; contact production PostgreSQL; deploy; or treat validation evidence as a spend or execution capability. Immutable
producer evidence and a different independent report-only zero-repair review are required before ordinary integration.

Producer verification passed 23/23 dedicated tests, 373/373 CR13A tests, the complete 769/421/392 lifecycle, all five
build phases, 4/4 rendered routes, migrations 0001-0037/122 tables, TypeScript, lint, macOS stage zero, whitespace, and
clean status. The first independent review's one Medium hostile-row coercion finding is preserved. Corrected product
`6028badb6db6b0455e9bed02c45751ea81517fa4` validates every stored scalar before coercion, hashing, regex use, length
access, or comparison. A second different reviewer passed all ten groups and fourteen commands exactly once with 0
residual High/Medium/Low and zero consumption, source lookup/invocation, protected native, production-database,
network, provider, or external effects. Preserve `docs/reviews/CR13A_LIVE_360_INDEPENDENT_REREVIEW.md`; SHA-256
`2dbf2c395ba8a95c41898cba05309551ca4e7be8e2b04e706f1fed1b7828cd47`.

## CR13A-LIVE-370 — atomic invocation-authorization consumption

Status: architecture frozen; PostgreSQL-compatible repository implementation may proceed on accepted corrected
LIVE-360. Use Sol xhigh.

LIVE-370 may add migration 0038 with one authenticated append-only consumption stream/head and extend the store with
one exact `consumeForInvocation` method. A third byte-distinct protected key authenticates consumption state. The spend
transaction must repeat full registration/nonce/lineage and same-session database-time verification immediately before
one unique durable insert. Success reports only `consumed_pending_post_transaction_time_recheck`; exact replay or
commit uncertainty cannot reach the source.

The block must not issue/revoke/list authorizations; accept caller time/callables; perform the post-transaction time
recheck; import/modify/retrieve/invoke LIVE-330; inspect descriptors; read/expose protected native material; create an
observation/attestation/candidate/owner authorization; open a listener; wire application/runtime/provider use; contact
production PostgreSQL; deploy; or treat consumption evidence as source authority. Immutable producer evidence and a
different independent report-only zero-repair review are required before ordinary integration.

Producer verification passed 34/34 dedicated tests, 384/384 CR13A tests, the complete 769/421/392 lifecycle, all five
build phases, 4/4 rendered routes, migrations 0001-0038/124 tables, TypeScript, lint, macOS stage zero, whitespace, and
clean status. Product `6f908ccd1f65f48a5d874fa0da96afe301d8decf` was accepted by a fresh different reviewer
after all twelve groups and fourteen commands passed exactly once with 0 High/Medium/Low, verified disposable cleanup,
and zero source lookup/invocation, native, listener, production-database, network, provider, or external effects.
Preserve `docs/reviews/CR13A_LIVE_370_INDEPENDENT_REVIEW.md`; SHA-256
`c1b22f9b8012328f4709c608c4a53292be279f47070aec6136ab40293618f490`.

## CR13A-LIVE-380 — post-transaction database-time recheck

Status: architecture frozen; read-only repository implementation may proceed on accepted LIVE-370. Use Sol xhigh.

LIVE-380 may extend the authorization store with one exact `recheckAfterConsumption` method. It accepts only the exact
sealed authorization and exact fresh LIVE-370 receipt, then opens a new transaction, reauthenticates the complete
registration/nonce/consumption state, requires the exact stored spend, and only then reads `clock_timestamp()` again.
Database time cannot regress before the consumption time and must remain at or after not-before and strictly before
expiry. Success is immutable sanitized `consumed_and_post_transaction_time_rechecked` evidence with no authority.

The block must not add a migration or new spend; issue/revoke/list/refund authorizations; accept caller time/callables;
import/modify/retrieve/invoke LIVE-330; look up a source; inspect descriptors; read/expose protected native material;
create an observation/attestation/candidate/owner authorization; open a listener; wire application/runtime/provider
use; contact production PostgreSQL; deploy; or treat the fresh or rechecked receipt as a bearer capability. Immutable
producer evidence and a different independent report-only zero-repair review are required before ordinary integration.

Producer verification passed 42/42 dedicated tests, 392/392 CR13A tests, the complete 769/421/392 lifecycle, all five
build phases, 4/4 rendered routes, migrations 0001-0038/124 tables, TypeScript, lint, macOS stage zero, whitespace, and
clean status. Product `1b79bbc75dfe74ce0777bcc33cbcc801054113f0` was accepted by a fresh different reviewer
after all twelve groups and fourteen commands passed once with 0 High/Medium/Low, verified cleanup, and zero new spend,
source/native/listener/production-database/network/provider/external effects. Preserve
`docs/reviews/CR13A_LIVE_380_INDEPENDENT_REVIEW.md`; SHA-256
`4a5f60f8ca2ad08ee04f1603773279aef97558edfa27acda1604592f8ae610bd`.

## CR13A-LIVE-390 — private fresh-spend/recheck composition contract

Status: exact product `34640c7c6a3c63b781aa848f687ae1c23e7c2dee` implemented with producer verification;
different independent review pending. Use Sol xhigh.

LIVE-390 may freeze one inert private contract requiring a future non-exported control flow to obtain its own fresh
LIVE-370 spend, immediately complete LIVE-380's post-transaction database-time recheck with the same sealed
authorization and exact fresh receipt, keep both receipts private, preserve terminal failure and no-retry semantics,
and stop before the first source lookup. It may export only immutable safe contract/status records, fixed rule/stage/
blocker/outcome arrays, strict parsers, and safe errors.

The block must not import or instantiate the authorization store; add executable composition; call validation,
consumption, recheck, database, or source behavior; accept caller receipts/time/callables; add a migration; import,
modify, retrieve, or invoke LIVE-330; inspect descriptors; read/expose protected native material; create an observation,
attestation, checkpoint, candidate, owner authorization, listener, physical attempt, runtime/provider/deployment
behavior; clear a blocker; or contact production state. Immutable producer evidence and a different independent
report-only zero-repair review are required before ordinary integration.

Producer verification passed 11/11 dedicated tests, 403/403 CR13A tests, the complete 769/421/392 lifecycle, all five
build phases, 4/4 rendered routes, migrations 0001-0038/124 tables, TypeScript, lint, macOS stage zero, whitespace, and
clean status. The product binds accepted LIVE-370 and LIVE-380 evidence, publishes 28 zero actuals and eight false
grants, has only the safe barrel as a production consumer, and adds no executable composition, database, source,
native, provider, network, or external effect. Independent review remains required; see
`docs/reviews/CR13A_LIVE_390_INDEPENDENT_REVIEW_PACKET.md`.
