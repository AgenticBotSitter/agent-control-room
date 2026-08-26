# Control Room completion program

**Status:** Architect-owned execution program  
**Frozen:** 2026-08-26  
**Scope:** Every remaining product block from CR-5D through CR-10  
**Operating rule:** Codex owns architecture, security, migrations, authority, integration, adversarial acceptance, and releases. External workers build all bounded non-overlapping product slices after their contracts and dependencies are ready. No qualification-only work is issued.

## How work moves without owner relaying

1. This program is the durable dependency graph. The owner does not need to carry tasks between Codex and workers.
2. Codex freezes the next security or interface contract and publishes all independent product capsules that contract unlocks.
3. Workers claim directly from GitHub through `/claim <route>`. A worker may hold multiple independent claims up to its route limit.
4. Submission immediately releases route capacity. The worker claims another ready jobber while review continues.
5. Codex reviews in batches, promotes accepted results to the named integration branch, resolves cross-module interactions, and publishes newly unblocked capsules.
6. A failed or ambiguous attempt uses `/blocked`; the worker preserves evidence and moves to another ready jobber. Codex repairs the contract, integrates a safe correction, replaces the capsule, or closes it.
7. The owner is contacted only for a genuinely owner-controlled gate: credentials, installs, native host actions, live infrastructure, external effects, consequential approvals, or block/release integration where the platform requires explicit approval.

`READY NOW` means a frozen capsule can be claimed. `CONTRACT` means Codex must freeze the exact boundary. `DEPENDENCY` means the work is real and specified here but cannot safely compile or integrate until named predecessors land. `OWNER` means a live or consequential action cannot be delegated. A future item is never labeled ready merely to keep a worker busy.

## Immediate production queue

All five items below are effect-free CR-5D production work on non-overlapping paths. They are the only currently claimable tasks in this program.

| ID | Owner | Product output | Dependency | State |
|---|---|---|---|---|
| CR5D-EXEC-001 | Bot | Deterministic synthetic executor, checkpoints, cancellation, and crash simulation | Frozen executor contract | COMPLETE |
| CR5D-EXEC-002 | Bot | Text artifact manifest and separate producer evidence claim | Frozen executor contract | COMPLETE |
| CR5D-UI-001 | Bot | Accessible artifact/evidence card that never confuses a producer claim with verification | Frozen initial UI contract | COMPLETE |
| CR5D-UI-002 | Bot | Accessible synthetic execution event timeline | Frozen initial UI contract | COMPLETE |
| CR5D-UI-003 | Bot | Worker drain/resume/quarantine request panel with no client-side authority | Frozen initial UI contract | COMPLETE |

## Critical path

```text
CR5D executor/evidence/UI
  -> Codex bridge, persistence, storage, authority and recovery integration
  -> CR5Q synthetic vertical security gate
  -> CR6 fleet services, discovery, scheduler, services and operator surfaces
  -> CR6Q fleet/scheduler gate
  -> CR7 Hermes + Codex + normalized runs + MCP + package registry
  -> CR7Q harness/MCP gate
  -> CR8 Claude + Completion Gate + Telegram + node-local secrets
  -> CR8Q approval/secrets gate
  -> CR9 project adapters and separately approved live rehearsal
  -> CR10 operations, recovery, public packages and independent release gate
```

Work within a block runs in parallel where dependencies permit. Security and integration gates remain serial because they define what downstream code is allowed to assume.

## CR-5D and CR-5Q — first executable vertical slice

| ID | Owner | Deliverable | Gate |
|---|---|---|---|
| CR5D-EXEC-001/002 | Bot | Executor and artifact/evidence modules | COMPLETE |
| CR5D-UI-001/002/003 | Bot | Evidence, timeline, and worker-operation components | COMPLETE |
| CR5D-INT-001 | Codex | Admitted execution coordinator; cancel on lease/authority expiry; one terminal outcome | COMPLETE |
| CR5D-INT-002 | Codex | Map lifecycle events to protocol events and durable bridge delivery | COMPLETE |
| CR5D-INT-003 | Codex | Persist attempts, checkpoints, terminal state, and artifact lineage transactionally | CODEX ACTIVE |
| CR5D-STOR-001 | Codex | Freeze and implement bounded artifact storage port plus in-memory adapter | COMPLETE |
| CR5D-STOR-002 | Codex | Disposable filesystem/object adapter with containment, atomicity, hashes, and ambiguity handling | STOR-001; OWNER for live namespace |
| CR5D-CTRL-001 | Codex | Quarantine/drain command authority, version binding, idempotency, audit, and API | CR5C security core |
| CR5D-UI-004 | Codex integration | Integrate accepted components into worker/artifact pages and safe command receipts | UI-001/002/003, CTRL-001 |
| CR5D-REC-001 | Bot | Deterministic kill/restart/reconciliation scenarios | INT-001/002/003, STOR-001 |
| CR5D-ENV-001 | Codex + Owner | Isolated PostgreSQL/control-plane/node namespace and teardown | OWNER |
| CR5D-ACC-001 | Codex | Dashboard/API to DB to node to evidence/review end-to-end acceptance | All CR5D outputs |
| CR5Q-001 | Codex + independent review | Crash, restore, replay, redaction, secret-canary, and threat disposition | ACC-001 |

CR-5D exits only when one synthetic job completes with audit, restart recovery, and visibly separate artifact locator, producer claim, and independent verification state.

## CR-6A — native service packaging

| ID | Owner | Deliverable | Gate |
|---|---|---|---|
| CR6A-CON-001 | Codex | Cross-platform service identity, lifecycle, isolation, paths, logging, update, rollback, and native-effect contract | CR5Q |
| CR6A-LNX-001 | Bot | systemd unit, value-free environment template, install/uninstall, diagnostics, static tests | CON-001 |
| CR6A-MAC-001 | Bot | launchd package, install/uninstall, diagnostics, static tests | CON-001; unresolved macOS security status remains visible |
| CR6A-WIN-001 | Bot | Windows Service package and Job Object cancellation wrapper | CON-001 |
| CR6A-TST-001 | Bot | Effect-free cross-platform service package conformance harness | LNX/MAC/WIN packages |
| CR6A-NATIVE-LNX/MAC/WIN | Codex + Owner | Real start/restart/cancel/sleep/reboot/key-store/isolation evidence per host | OWNER; package accepted |

## CR-6B — discovery, telemetry, capabilities, and benchmarks

| ID | Owner | Deliverable | Gate |
|---|---|---|---|
| CR6B-CON-001 | Codex | Versioned discovery, inventory, telemetry, capability, benchmark, fingerprint, freshness, and trust contracts | CR6A contract; CR5D protocol |
| CR6B-DISC-001 | Bot | Normalized static hardware/volume/network collectors without private host identity | CON-001 |
| CR6B-DISC-002 | Bot | Software, harness, executor, and tool inventory manifests | CON-001 |
| CR6B-DISC-003 | Bot | Stable material-change fingerprints and rediscovery triggers | DISC-001/002 |
| CR6B-TEL-001 | Bot | Bounded CPU/GPU/RAM/storage/network/power/thermal telemetry ports | CON-001 |
| CR6B-CAP-001 | Bot | Versioned capability probe runner with explicit pass/fail/blocked | CON-001, DISC-002 |
| CR6B-BENCH-001 | Bot | Benchmark runner, normalization, environment binding, and expiry | CAP-001 |
| CR6B-PERS-001 | Codex | Fleet history persistence, tenancy, indexing, freshness, and retention | CON-001 |
| CR6B-POL-001 | Codex | Scratch/resource/freshness eligibility gates | Telemetry, benchmarks, persistence |
| CR6B-NATIVE-001 | Codex + Owner | Real per-host inventory/probe/benchmark evidence | OWNER |

## CR-6C — scheduler, resources, and bottlenecks

| ID | Owner | Deliverable | Gate |
|---|---|---|---|
| CR6C-CON-001 | Codex | Deterministic allocation, fair-share debt, priority, deadline, cost, privacy, maintenance, semaphore, reservation, and explanation contract | Trusted CR6B inputs |
| CR6C-SCH-001 | Codex | Production scheduler and starvation bounds | CON-001 |
| CR6C-SEM-001 | Codex | Atomic exclusive-resource/GPU reservations, availability windows, expiry, and recovery | CON-001, CR6B-POL-001 |
| CR6C-POL-001 | Codex | Cost/privacy/quality/deadline/maintenance constraint evaluator | CON-001 |
| CR6C-BOT-001 | Bot | Seeded property generators for fairness, starvation, ties, and capacity invariants | CON-001 |
| CR6C-BOT-002 | Bot | Multi-project simulation catalogue for every allocation and failure mode | CON-001 |
| CR6C-BOT-003 | Bot | Evidence-backed bottleneck fixtures and expected recommendations | Bottleneck portion of CON-001 |
| CR6C-BNK-001 | Codex | Bottleneck and projected-impact engine | CON-001, BOT-003 |
| CR6C-ACC-001 | Codex | Concurrency, fairness, recovery, and explanation acceptance | All CR6C outputs |

## CR-6D — services, schedules, incidents, and reconciliation

| ID | Owner | Deliverable | Gate |
|---|---|---|---|
| CR6D-CON-001 | Codex | Desired/observed service state, recurrence, timezone/DST, deduplication, incident, and reconciliation contract | CR6C |
| CR6D-SVC-001 | Bot | Continuous-service reconciler | CON-001 |
| CR6D-SCH-001 | Bot | Cron/interval/once calculator and idempotent dispatcher | CON-001 |
| CR6D-INC-001 | Bot | Incident derivation, correlation, state, reason, remedy, and recovery projection | CON-001, SVC-001 |
| CR6D-PERS-001 | Codex | Transactional persistence, occurrence creation, outbox, and crash replay | Bot engines, CON-001 |
| CR6D-ACC-001 | Codex | Restart, clock-boundary, duplicate-delivery, incident/recovery acceptance | All CR6D outputs |

## CR-6E and CR-6Q — operator surfaces and fleet gate

| ID | Owner | Deliverable | Gate |
|---|---|---|---|
| CR6E-CON-001 | Codex | Fleet/bottleneck, Action Inbox, and Owner Focus view/command contracts | CR6B-D |
| CR6E-API-001 | Codex | Scoped/redacted fleet, history, service, incident, and bottleneck projections | CON-001, stores |
| CR6E-UI-001 | Bot | Portfolio/project fleet and bottleneck surfaces | CON-001 fixtures |
| CR6E-UI-002 | Bot | Worker status/resources/capabilities/software/projects/performance/history/security tabs | CON-001 |
| CR6E-UI-003 | Bot | Services, schedules, and incidents pages | CR6D, CON-001 |
| CR6E-ATT-001 | Codex | Canonical Action Inbox and legal-response policy | CON-001 |
| CR6E-UI-004 | Bot | Action Inbox filters, evidence, expiry, delivery, and safe response forms | ATT-001 |
| CR6E-FOCUS-001 | Codex | P0/Today semantics and scheduler projection without authority/fairness bypass | CR6C, CON-001 |
| CR6E-UI-005 | Bot | Owner Focus strip/editor | FOCUS-001 |
| CR6E-A11Y-001 | Bot | Cross-surface mobile, keyboard, semantic, and rendered test suite | UI slices |
| CR6E-ACC-001 | Codex + Owner | Owner-facing fleet and attention acceptance | All CR6E outputs |
| CR6Q-001 | Codex + independent review | Policy-bypass, starvation, capacity-race, platform-drift, stale-evidence, isolation, and redaction review | CR6A-E |

## CR-7 — Hermes, Codex, normalized harness runs, MCP, and package registry

| ID | Owner | Deliverable | Gate |
|---|---|---|---|
| CR7-FND-001/002 | Codex | Harness manifest/lifecycle/event/usage/lineage contracts and canonical persistence | CR6Q |
| CR7-FND-003/004 | Codex | Safe run normalization plus Session Watch projection/API | FND-001/002 |
| CR7-FND-005 | Bot | Responsive Session Watch UI and protected native links | FND-004 contract |
| CR7A-001 | Codex + Owner | Pin and discover disposable Hermes lifecycle | OWNER |
| CR7A-002 | Bot | Sanitized Hermes gateway/serve/session/usage/cron/reconnect/cancel fixtures | A-001 |
| CR7A-003/004 | Bot | Pinned gateway client and read-only serve projection adapter | FND contract, A-002 |
| CR7A-005/006 | Bot | Hermes composition, health, lifecycle and drift conformance | A-003/004 |
| CR7B-001 | Bot | Sanitized `codex exec --json` lifecycle fixtures | FND contract, pinned CLI |
| CR7B-002 | Bot | Codex process wrapper and safe structured-event decoder | B-001 |
| CR7B-003 | Codex | Worktree, directory, sandbox, cleanup, and authority mapping | B-002, CR6 isolation |
| CR7B-004/005/006 | Bot | Codex lifecycle, result/usage/file/test lineage, and conformance | B-002/003, FND normalization |
| CR7C-001/002 | Codex | MCP security contract, authentication, scope, replay, and redaction boundary | Hermes/Codex accepted |
| CR7C-003/004 | Codex | Scoped read tools plus policy-controlled proposal/delegation/approval-request tools | C-002 |
| CR7C-005 | Bot | Typed MCP clients and negative fixtures | C-001 |
| CR7C-006 | Codex | Synthetic MCP delegation, observation, evidence, and review end-to-end | C-002-005 |
| CR7D-001 | Codex | Public adapter SDK boundary | Two adapters accepted |
| CR7D-002/003/004 | Bot | Conformance kit, adapter refactor, and example adapter/docs | D-001 |
| CR7E-001/002 | Codex | Procedure/knowledge contracts and immutable registry persistence | CR7D |
| CR7E-003/004/005 | Bot | Registry services, harness mappings, compatibility cases, and UI | E-001/002 |
| CR7E-006 | Codex | Promotion/rejection/rollback acceptance | E-003-005 |
| CR7Q-001 | Codex + independent review | Harness, MCP, package authority, compatibility, and secret-exposure gate | All CR7 |
| CR7-I-001 | Codex | Hermes/Codex/Session Watch/MCP/package disposable vertical acceptance | CR7Q |

## CR-8 — Claude, Completion Gate, Telegram, and node-local secrets

| ID | Owner | Deliverable | Gate |
|---|---|---|---|
| CR8A-001/002 | Owner + Codex | Authenticated disposable Claude discovery and frozen authority/lifecycle mapping | CR7 |
| CR8A-003/004/005 | Bot | Sanitized fixtures, stream client, event decoder, adapter, permission/subagent/worktree/result mapping | A-002 |
| CR8A-006 | Owner + Codex | Authenticated lifecycle acceptance | OWNER |
| CR8B-001/002/003 | Codex | Separate approval/review/verification/finding/revision/preference contracts, domain, and persistence | CR7 |
| CR8B-004/005/006/007 | Codex | Exact approval/step-up, independence, risk floors, verification/evidence, bounded revisions | B-001-003 |
| CR8B-008 | Bot | Code/media/document/operation fixtures and adversarial cases | B-001 |
| CR8C-001 | Codex | Completion Gate view model and safe preview contract | CR8B |
| CR8C-002/003/004/005 | Bot | Review UI, evidence/media/diff/report previews, findings/revisions/preferences, mobile/a11y QA | C-001, B services |
| CR8D-001 | Codex | Telegram recipient/risk/webhook/replay/expiry/deep-link security contract | CR8B |
| CR8D-002/005 | Bot | Message rendering/preferences and sanitized callback/presentation fixtures | D-001 |
| CR8D-003/004 | Codex | Verified webhook ingress, allowlist, idempotency, delivery, retry, grouping, receipts | D-001/002 |
| CR8D-006 | Owner + Codex | Disposable bot/chat live callback and cleanup | OWNER |
| CR8E-001/002/003 | Codex | Reference-only secret contract, safe metadata catalog, node-local invocation and cleanup | CR5C, CR8B |
| CR8E-004/005/006 | Codex | Bitwarden, 1Password, and destination-native brokers | E-003 |
| CR8E-007 | Bot | Sanitized provider fixtures, failure cases, and operator docs | E-001 |
| CR8E-008 | Owner + Codex | Live canary, rotate, revoke, failure, and cleanup drills | OWNER |
| CR8Q-001 | Codex + independent review | Approval/review/Telegram/secrets adversarial gate | All CR8 |
| CR8-I-001 | Codex | Question-to-approval-to-evidence-to-independent-revision disposable workflow | CR8Q |

## CR-9 — real project integrations

| ID | Owner | Deliverable | Gate |
|---|---|---|---|
| CR9A-CB-000 | Codex | Content Blooms source-scheduled, read, receipt, disable, and rollback contract | CR7D, CR8Q |
| CR9A-CB-010/020/030/040 | Bot | Sanitized fixtures, read adapter, isolated synchronization, and transcription route comparison | CB-000, CR6/7 |
| CR9A-CB-050 | Codex | Placement-request authorization/version/idempotency/source-receipt contract | CB read path, CR8B |
| CR9A-CB-060/070 | Bot | Bounded placement command plus research/transcription/article project pack | CB-050, CR7E, CR8C |
| CR9A-CB-080/090 | Codex + Owner | Authenticated read rehearsal, rollback, threat review, and acceptance | OWNER; offline slices pass |
| CR9B-WF-000 | Codex | Wayfarer pack, media graph, artifact/QC/review/retention contract | CR7D/E, CR8Q |
| CR9B-WF-010/020/030 | Bot | Synthetic media fixtures, workflow compiler, typed probe/QC executors | WF-000, executor framework |
| CR9B-WF-040 | Codex | Local/R2 object scope, locator, retention, quarantine, and retry contract | CR8E, artifact core |
| CR9B-WF-050/060/070 | Bot | Storage adapter against fakes, media/review UI, GPU/scratch scheduling scenarios | WF-040, CR6, CR8C |
| CR9B-WF-080 | Codex + Owner | Measured Unreal scene/render benchmark | OWNER |
| CR9B-WF-090/100 | Bot | Frozen Unreal executor and upload/publish-preparation package without effect | WF-080 contract, CR8 |
| CR9B-WF-110/120 | Codex + Owner | Destination-idempotency/approval contract and separately authorized rehearsal or disabled state | OWNER |
| CR9B-WF-130 | Codex | Wayfarer acceptance and cross-project isolation | Prior WF work |
| CR9C-LIVE-000/010/020 | Codex + Owner | One-project bounded live rehearsal packet, exact effects, rollback, evidence, and CR9 disposition | OWNER |

## CR-10 — operations, public packaging, and release

| ID | Owner | Deliverable | Gate |
|---|---|---|---|
| CR10A-OPS-000 | Codex | Production topology, roles, secret references, health, deploy, rollback, and recovery contract | CR9 |
| CR10A-OPS-010/020/030/040 | Bot | Compose, systemd, value-free Cloudflare, health/readiness/resource checks | OPS-000 |
| CR10A-OPS-050/060 | Bot | Backup/WAL tooling and disposable PITR/clean-host restore harness | OPS-000 |
| CR10A-OPS-070/080/090 | Bot | Monitoring, update canary/rollback tooling, and executable runbooks | Operations foundations |
| CR10A-OPS-100 | Codex | Privacy, retention, deletion, legal-hold, and audit semantics | CR8/9 data |
| CR10A-OPS-110 | Bot | Dry-run/idempotent retention and quarantine cleanup | OPS-100 |
| CR10A-OPS-120/130 | Codex + Owner | Real restore, canary, incident drill, RPO/RTO and operations disposition | OWNER |
| CR10B-PUB-000 | Codex | Public/private boundaries, supported versions, signing and certification semantics | CR10A |
| CR10B-PUB-010/020/030/040 | Bot | Public core, adapter SDK, conformance kit, and synthetic reference adapters | PUB-000, CR7D |
| CR10B-PUB-050/060/070/080 | Bot | Synthetic example deployment, tested guides, reproducible release tooling, clean-room install | Public packages |
| CR10C-MECH-010/020/030/040 | Bot | SBOM, license/NOTICE inventory, schema/fixture/link normalization, private-data scan | Release candidate |
| CR10C-MECH-050 | Codex | License and public-tree disposition | Mechanical evidence |
| CR10Q-SEC-000/010 | Codex + independent review | Full public threat/privacy/recovery review and independent execution | Release candidate |
| CR10Q-SEC-020 | Bots + Codex | Bounded remediations; Codex retains security/contract fixes | Review findings |
| CR10Q-SEC-030/040 | Codex + Owner | Supported-version/disclosure policy and real private reporting/signing resources | OWNER |
| CR10Q-SEC-050 | Codex | Final clean-room, restore, attack, privacy, repository, and finding gates | All prior work |
| CR10Q-SEC-060 | Codex + Owner | Exact first public release, provenance, signing, rollback/revocation | OWNER |

## Block acceptance and promotion

Every bot contribution passes capsule intake and focused tests. Every integration branch then runs, as applicable:

```text
pnpm check
pnpm lint
pnpm test
pnpm test:build
pnpm db:verify
```

Passing worker tests do not close a block. Codex must reconcile interactions, run the named security/durability gate, record risks and evidence, and update `docs/BUILD_STATUS.md`. A blocked native host or live credential gate remains visible, but it does not stop unrelated effect-free work on an isolated integration branch.
