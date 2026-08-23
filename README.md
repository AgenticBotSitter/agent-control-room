# Control Room

Control Room is a private, project-agnostic operations layer for coordinating projects, workers, machines, agents, approvals, and capacity from one interface. Lo-Fi Wayfarer and Content Blooms are initial fixture projects; neither defines the platform.

![Abstract Control Room routing preview](public/control-room-preview.png)

This repository currently implements **CR-0 through CR-5A**:

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

There are deliberately **no live project adapters, credentials, production commands, Telegram actions, Unreal jobs, or Content Blooms changes** in this phase.

## Architecture

Projects publish a small sanitized projection through `control-room-project-adapter/v1`. Control Room owns its projection database, global worker registry, portfolio policy, simulation, audit, and user interface. Each source project keeps authority over its own domain records and transitions.

Three scheduling authority modes are supported:

- `control_room_native`: Control Room may assign a registered worker.
- `source_scheduled`: Control Room requests a preference; the source scheduler makes the lease/assignment.
- `advisory`: Control Room recommends only.

Workers are global resources and can be exclusive, preferred, shared, opportunistic, or manually pinned. A worker can serve several projects, and a project can expose several eligible routes for the same capability (for example MLX on macOS, CUDA on Windows, CPU on Linux, or an approved provider).

## Local setup

Prerequisites: Node.js 22.13+ and pnpm 11.

```bash
pnpm install
pnpm check
pnpm test
pnpm db:verify
pnpm protocol:generate
pnpm dev
```

The UI uses synthetic fixtures by default. Open `http://localhost:3000`.

For a future PostgreSQL deployment, copy `.env.example` to `.env.local` and provide a private `DATABASE_URL`. Do not commit secrets.

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
- [CR-3 architecture package](docs/CR3_INDEX.md)
- [Current build status and next model setting](docs/BUILD_STATUS.md)
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
