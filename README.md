# Control Room

Control Room is a private, project-agnostic operations layer for coordinating projects, workers, machines, agents, approvals, and capacity from one interface. Lo-Fi Wayfarer and Content Blooms are initial fixture projects; neither defines the platform.

![Abstract Control Room routing preview](public/control-room-preview.png)

The repository contains accepted contracts/components through **CR13A-LIVE-500** and a runnable
**repository-fake local pilot**. It is not yet an operational multi-machine private beta: general live project
creation, production login, mounted Hermes/Codex dispatch, live ABS collection and fleet update/recovery still
need integration and real acceptance. The GitHub V2 worker queue is the existing build-coordination mechanism.

**CR14A: private-beta integration rebaseline**, the **CR14B runtime/access/project foundation**, and the
**ordinary-project private application** are independently accepted for repository work. The separate private
pages now use authenticated SQL services in compiled integration tests; they are not deployed. Next is shared
Idea-project discovery and the remaining private integration; the private pilot is not complete. See the
[private application acceptance](docs/CR14B_PRIVATE_APPLICATION_ACCEPTANCE.md),
[current completion program](docs/CONTROL_ROOM_COMPLETION_PROGRAM.md),
[integration decisions](docs/CR14A_INTEGRATION_DIRECTION.md), and
[build status](docs/BUILD_STATUS.md). The older phase summary below is historical architecture, not current readiness.

- **CR-0 — Contract:** versioned project-adapter types and schemas, authority boundaries, safe projections, cursors, idempotency, command receipts, and redaction rules.
- **CR-1 — Read-only interface:** an all-project portfolio, attention queue, running work, blockers, worker and agent views, project drilldowns, worker history, and a deterministic capacity simulator.
- **CR-2 — Persistence and simulation:** PostgreSQL migrations, a projection store, adapter registry, cursor ingestion, append-only audit, worker/capability routes, benchmarks, allocation policies, recommendations, and synthetic tests.
- **CR-3 — Accepted architecture:** security, durability, protocol, product-surface, deployment, extension, and phased-build decisions.
- **CR-4A — Canonical domain contract:** versioned records, runtime validators, generated JSON Schema, explicit state machines, and authority-containment rules.
- **CR-4B — Transactional persistence:** normalized PostgreSQL tables, tenant-bound lineage, optimistic state transitions, lease epochs, inbox/outbox delivery, idempotency, stale-claim recovery, and dead-letter handling.
- **CR-4C — Security core:** application identities and scoped grants, deterministic policy decisions, canonical digest verification, secret rejection/redaction, strong exact-operation approval consumption, and production database-role definitions.
- **CR-4D — Audit and operations core:** per-tenant tamper-evident audit chains, external-anchor interface, safe operational errors, and fail-closed production configuration validation.
- **CR-4Q — Independent review:** adversarial policy, authority, tenant-lineage, delivery, audit, configuration, and database-privilege review with all high/medium findings remediated.
- **CR-5A — Node protocol and identity:** strict versioned wire/enrollment schemas, generated JSON Schema, Ed25519 challenge/proof enrollment, immutable public-key identity, signed frame authentication, rate limits, and durable replay/sequence protection.
- **CR-5B — Portable bridge core:** outbound connection/reconciliation state machine, acknowledgements, deterministic heartbeat scheduling, SQLite crash journal, backpressure, and safe retry filtering without platform or harness coupling.
- **CR-5C contract freeze:** owner-anchored node ceilings, complete lease authority, protected key/trust boundaries, expiry, durable effect admission, safe receipts, and canonical target rules are normative in `docs/CR5C_FINAL_SECURITY_CONTRACT.md`.
- **CR-5C.1 — Canonical security contracts:** strict signed ceiling, trust-bundle, approval, normalized request/decision, executor-capability, safe-receipt, and complete lease-authority schemas with generated JSON Schema and adversarial fixtures.
- **CR-5C.2 — Protected-store contracts:** separated private-signing/server-trust/approval-trust interfaces, injected clocks, explicit fail-closed provider selection, deterministic fakes, and a protected-store bridge signer.

There are deliberately **no live project adapters, credentials, production commands, Telegram actions, Unreal jobs, or Content Blooms changes** in this phase.

## Architecture

Projects publish a small sanitized projection through `control-room-project-adapter/v1`. Control Room owns its projection database, global worker registry, portfolio policy, simulation, audit, and user interface. Each source project keeps authority over its own domain records and transitions.

Three scheduling authority modes are supported:

- `control_room_native`: Control Room may assign a registered worker.
- `source_scheduled`: Control Room requests a preference; the source scheduler makes the lease/assignment.
- `advisory`: Control Room recommends only.

Workers are global resources and can be exclusive, preferred, shared, opportunistic, or manually pinned. A worker can serve several projects, and a project can expose several eligible routes for the same capability (for example MLX on macOS, CUDA on Windows, CPU on Linux, or an approved provider).

## Local setup

Prerequisites: Node.js 22.13+ and the declared `pnpm@11.19.0`.
Run stage zero first, substituting `windows` or `linux` for `macos` on those hosts.
If dependencies are missing, follow [checkout preparation](docs/WORKER_CHECKOUT_PREPARATION.md)
and obtain any required install/download authority; do not treat setup as platform qualification.

```bash
node scripts/qualification/platform-key-store-stage-zero.mjs --platform macos
pnpm check
pnpm test
pnpm db:verify
pnpm domain:generate
pnpm protocol:generate
pnpm policy:generate
pnpm dev
```

The UI uses synthetic fixtures by default. Open `http://localhost:3000`.

Production configuration is a later scoped VPS/PostgreSQL/authentication step, not an instruction to connect
this fixture preview to a live database. Do not commit secrets or configure a public database endpoint.

## Verification commands

```bash
pnpm check
pnpm test
pnpm db:verify
pnpm test:build
```

## Contract and onboarding

- [Founding contract](docs/FOUNDING_CONTRACT.md)
- [Project adapter guide](docs/ADAPTER_IMPLEMENTATION_GUIDE.md)
- [New project checklist](docs/NEW_PROJECT_CHECKLIST.md)
- [Security and authority](docs/SECURITY_AND_AUTHORITY.md)
- [Migration notes](docs/MIGRATIONS.md)
- [CR-0 through CR-2 verification](docs/CR2_VERIFICATION.md)
- [Research synthesis and build decisions](docs/RESEARCH_SYNTHESIS_AND_BUILD_DECISIONS.md)
- [Zide and Devin workflow research](docs/COMPETITOR_WORKFLOW_RESEARCH_ZIDE_DEVIN.md)
- [Source provenance and repository completeness](docs/CONTROL_ROOM_SOURCE_PROVENANCE.md)
- [CR-3 architecture package](docs/CR3_INDEX.md)
- [Current build status and next model setting](docs/BUILD_STATUS.md)
- [Mac Codex handoff](docs/CODEX_MAC_HANDOFF.md)
- [Hermes delegation and GitHub bootstrap playbook](docs/HERMES_DELEGATION_PLAYBOOK.md)
- [CR-4A canonical domain contract](docs/CR4A_DOMAIN_CONTRACT.md)
- [CR-4A verification](docs/CR4A_VERIFICATION.md)
- [CR-4B transaction design](docs/CR4B_TRANSACTION_DESIGN.md)
- [CR-4B verification](docs/CR4B_VERIFICATION.md)
- [CR-4C security core](docs/CR4C_SECURITY_CORE.md)
- [CR-4C verification](docs/CR4C_VERIFICATION.md)
- [CR-4D audit and operations core](docs/CR4D_AUDIT_AND_OPERATIONS.md)
- [CR-4D verification](docs/CR4D_VERIFICATION.md)
- [CR-4Q security and data-integrity review](docs/CR4Q_SECURITY_DATA_INTEGRITY_REVIEW.md)
- [CR-4Q real PostgreSQL rehearsal plan](docs/CR4Q_REAL_POSTGRES_REHEARSAL_PLAN.md)
- [CR-5A node protocol and device identity](docs/CR5A_NODE_PROTOCOL_AND_IDENTITY.md)
- [CR-5B portable node bridge core](docs/CR5B_PORTABLE_NODE_BRIDGE.md)
- [CR-5C final node-security contract](docs/CR5C_FINAL_SECURITY_CONTRACT.md)
- [CR-5C.1 canonical node-security contracts](docs/CR5C1_CANONICAL_SECURITY_CONTRACTS.md)
- [CR-5C.2 protected-store and clock contracts](docs/CR5C2_PROTECTED_STORE_CONTRACTS.md)
- [Project adapter JSON Schema](contracts/project-adapter-v1.schema.json)
- [Command receipt JSON Schema](contracts/command-receipt-v1.schema.json)
- [Signed node frame JSON Schema](contracts/control-room-node-v1-frame.schema.json)

## Fixture packs

- **Lo-Fi Wayfarer:** native scheduling, long-running media generation, reviews, and render capacity.
- **Content Blooms:** source-scheduled transcription/generation/review, with Control Room requesting route preferences rather than editing source leases.
- **Website Operations:** advisory-only maintenance work, proving that the model is not media-specific.

See [fixtures/README.md](fixtures/README.md).

## Add a project

1. Choose an authority mode.
2. Implement the read adapter and sanitized change feed.
3. Map domain states to normalized states without discarding domain state.
4. Register required capabilities and acceptable routes.
5. Pass schema, redaction, cursor, idempotency, tenancy, offline, and version tests.
6. Add a synthetic fixture pack before requesting a live integration phase.

Live commands remain a separate, explicitly approved phase.

## Bootstrap collaboration

Until Control Room can dispatch its own work, the private GitHub repository is the coordination layer. Codex retains architecture and review ownership; Hermes workers receive bounded issues, work on isolated branches, and return pull requests. No agent pushes directly to `main`, and every Hermes contribution is reviewed before merge. See the [delegation playbook](docs/HERMES_DELEGATION_PLAYBOOK.md).
