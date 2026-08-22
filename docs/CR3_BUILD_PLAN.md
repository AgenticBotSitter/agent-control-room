# CR-3 phased build plan

**Status:** Proposed  
**Rule:** A phase authorizes only the changes named in that phase. Passing tests—not elapsed time—advances the build.

## Delivery strategy

Build thin vertical slices through production-shaped contracts. Synthetic adapters and disposable credentials come before live projects. Security, recovery, and observability tests arrive with the feature they protect rather than at the end.

GitHub is the **bootstrap coordination plane** while Control Room is being built. Codex/Sol owns architecture, integration, and acceptance. Hermes agents may implement bounded work packets on isolated branches; every returned pull request is tested and reviewed before merge. When CR-7 is operational, the same work-packet metadata becomes input to Control Room rather than being discarded.

## Phase map

| Phase | Outcome | Live external effects? |
|---|---|---|
| CR-3 | Accepted architecture and decision package | No |
| CR-4 | Secure core domain and persistence foundation | No |
| CR-5 | Enrolled synthetic node and durable cross-machine job slice | Disposable only |
| CR-6 | Fleet discovery, scheduling, workers, bottlenecks, services | Synthetic/local checks |
| CR-7 | Hermes and Codex adapters plus northbound MCP | Bounded disposable tests |
| CR-8 | Claude, approvals, review, Telegram, secrets | Bounded disposable tests |
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
| CR-5D | Synthetic executor, artifact UI, deterministic tests | Vertical-slice acceptance and threat review |
| CR-6A–CR-6B | Native-machine probes, service packaging, telemetry and benchmark implementations | Capability semantics, trust levels and cross-platform acceptance |
| CR-6C | Simulation cases, property-test generators and analysis fixtures | Scheduler/fairness algorithm and safety invariants |
| CR-6D–CR-6E | Services, schedules, dashboard components, accessibility tests | Domain integration and owner-facing acceptance |
| CR-7A | Hermes lifecycle recordings, pinned fixtures and bounded adapter code | Hermes authority mapping and adapter acceptance |
| CR-7B–CR-7C | Test fixtures and client examples | Codex lifecycle, sandbox semantics and northbound MCP authority |
| CR-7D | SDK extraction, examples and conformance implementations | Public contract review |
| CR-8A | Recorded Claude fixtures after authenticated discovery | Claude authority and lifecycle mapping |
| CR-8B | Test cases and non-authoritative UI fixtures | Approval domain and consequential-action policy |
| CR-8C–CR-8D | Review UI, Telegram presentation, callback fixtures | Approval binding, webhook security and final integration |
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
| CR-7 Hermes/Codex/MCP | 12–20 | 9–15 | 2–4 weeks |
| CR-8 approvals/Telegram/secrets | 15–24 | 11–18 | 3–5 weeks |
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
| CR-5D | Synthetic executor, artifact flow, initial worker UI | `gpt-5.6-terra` | `high` | Full vertical slice with moderate UI work | Synthetic cross-machine job completes with audit/artifact |
| CR-5Q | Crash, restore, adversarial protocol, and secret-canary review | `gpt-5.6-sol` | `max` | First real end-to-end security/durability gate | Clean restore/reconcile and attack suite pass |
| CR-6A | macOS, Windows, and Linux service packaging | `gpt-5.6-terra` | `high` | Platform-specific implementation and diagnostics | Start/restart/cancel/sleep/reboot checks pass per OS |
| CR-6B | Discovery, telemetry, capability probes, benchmarks | `gpt-5.6-terra` | `high` | Many deterministic integrations and schemas | Change detection, expiration, resource-threshold tests pass |
| CR-6C | Cross-project scheduler, fairness, semaphores, bottlenecks | `gpt-5.6-sol` | `xhigh` | Algorithmic correctness and starvation/resource risk | Simulation/property tests and evidence explanations pass |
| CR-6D | Services, schedules, incidents, reconciliation | `gpt-5.6-terra` | `high` | Stateful but contract-driven feature work | Recurrence, deduplication, incident and recovery tests pass |
| CR-6E | Portfolio/project/worker/bottleneck dashboard | `gpt-5.6-terra` | `high` | Balanced implementation plus frontend judgment | Responsive/accessibility/render tests and owner review pass |
| CR-6Q | Fleet/scheduler architecture review | `gpt-5.6-sol` | `xhigh` | Checks policy bypass, starvation, and platform drift | Findings closed and acceptance matrix complete |
| CR-7A | Hermes execution/read adapter and fixtures | `gpt-5.6-sol` | `high` | Large, version-sensitive foreign interface | Canonical lifecycle suite and pinned fixtures pass |
| CR-7B | Codex worker adapter and worktree/result mapping | `gpt-5.6-sol` | `high` | Agentic coding lifecycle and sandbox correctness | Start/stream/cancel/resume/change/test/result suite passes |
| CR-7C | Northbound Control Room MCP server | `gpt-5.6-sol` | `xhigh` | New agent-facing authority surface | Scope, approval, replay, redaction, and delegation tests pass |
| CR-7D | Adapter SDK and conformance-kit extraction | `gpt-5.6-terra` | `high` | Generalization after two real harness mappings | Hermes/Codex pass the same public conformance suite |
| CR-7Q | Harness/MCP security and compatibility review | `gpt-5.6-sol` | `xhigh` | Ensures harnesses cannot bypass core authority | Findings closed or adapters remain disabled |
| CR-8A | Authenticated Claude adapter | `gpt-5.6-sol` | `high` | Version-sensitive lifecycle integration | Authenticated lifecycle and usage/worktree tests pass |
| CR-8B | Strong approval and review domain/backend | `gpt-5.6-sol` | `xhigh` | Consequential-action authorization | Operation-binding, expiry, replay, step-up tests pass |
| CR-8C | Review UI and media/diff preview surfaces | `gpt-5.6-terra` | `high` | Frontend and artifact interaction | Mobile/accessibility/preview/decision-lineage tests pass |
| CR-8D | Telegram notification and action adapter | `gpt-5.6-terra` | `high` | External callbacks with bounded authority | Signature/allowlist/idempotency/quiet-hour/risk tests pass |
| CR-8E | Bitwarden and 1Password node-local brokers | `gpt-5.6-sol` | `xhigh` | Secret-exposure and privilege risk | Secret canary, scope, rotate/revoke/failure tests pass |
| CR-8Q | Approval/secrets adversarial review | `gpt-5.6-sol` | `max` | Last gate before project credentials | No central plaintext path or approval bypass remains |
| CR-9A | Content Blooms source-scheduled adapter | `gpt-5.6-sol` | `high` | Must preserve foreign lease/authority semantics | Read-only then bounded command receipts pass |
| CR-9B | Lo-Fi Wayfarer project pack and media workflow | `gpt-5.6-terra` | `high` | Larger domain implementation under settled core | Synthetic media/QC/review/assembly flow passes |
| CR-9C | First bounded live integration rehearsal | `gpt-5.6-sol` | `xhigh` | Cross-system rollback and production-risk review | Owner-approved rehearsal, rollback, and audit pass |
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
4. Implement a synthetic typed executor that sleeps, checkpoints, produces a text artifact manifest, accepts cancellation, and can simulate crashes.
5. Add node/worker dashboard pages and quarantine/drain controls.
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

One synthetic job travels dashboard/API → PostgreSQL → remote node → artifact → review/result with complete audit and restart recovery.

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

### Tests

- machine hardware or disk changes trigger rediscovery;
- low disk prevents unsafe claim and recommends offload;
- benchmark expiration removes or downgrades route eligibility;
- one project cannot starve every other project indefinitely;
- manual/exclusive/preferred/shared/opportunistic modes behave deterministically;
- service schedules do not flood the ordinary job board;
- offline nodes remain visible with reason/remedy.

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

### Northbound MCP

- authenticated/scoped request, project, worker, job, attention, and artifact tools;
- a Codex task can propose/delegate work and later inspect results;
- MCP cannot issue secrets or bypass approvals.

### Exit criteria

- Hermes and Codex each pass the same canonical lifecycle suite or declare unsupported verbs;
- a Codex project task delegates a synthetic job through MCP and reviews the returned result;
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
- review items with image/video/audio/diff/report previews;
- AI pre-review comments clearly attributed and non-authoritative;
- request changes/retry/revise workflow.

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

One disposable workflow can ask a question, request approval, receive a Telegram response where permitted, resolve a node-local scratch credential, produce review media, and complete without secret leakage.

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

- final Control Room domain/subdomain names;
- exact quiet hours and notification routing;
- per-project budgets and approval thresholds;
- retention duration;
- which password manager is enabled first;
- Docker versus native deployment after Johnny5 discovery;
- when an optional standby or managed database is worth its cost;
- which project becomes the first live integration after synthetic proof.

The dashboard will expose configurable policy/preferences where safe; security invariants are not user-disableable convenience settings.
