# Control Room cross-project build handoff

**Prepared:** 2026-08-22
**Audience:** The Codex task working in the YouTube AI Music / Wayfarer workspace

## Decision

Control Room is a third, independent private application. Do not implement it
as a Wayfarer-only dashboard and do not place it inside Content Blooms.

Wayfarer Studio and Content Blooms are separate project integrations behind a
versioned project-adapter contract. Each product keeps authority over its own
domain state. Control Room owns cross-project projections, workers, agents,
capabilities, allocations, attention items, operator commands, and its own
audit history.

The canonical Content Blooms integration architecture is:

`C:\Users\Dad\Documents\ChatGPT\Content Pipeline\docs\control-room-integration-architecture.md`

Read it completely before implementation, together with:

1. `CONTROL_ROOM_PLATFORM_ARCHITECTURE.md`
2. `RIVERFLOW_DASHBOARD_AND_WORKFLOW_SPEC.md`
3. `CONTROL_ROOM_CONNECTIVITY_AND_VPN_PLAN.md`
4. `DISTRIBUTED_RENDER_ORCHESTRATION_PLAN.md`

If the older documents use RiverFlow or Wayfarer-specific wording for the
global product, the project-agnostic Control Room decision wins. Media concepts
belong in the Wayfarer project pack.

## Build now

Create a separate private Control Room repository and implement only the first
three bounded milestones:

### CR-0 — Founding contract

- generic IDs and source-system references;
- normalized work states plus domain-specific state;
- read adapter and command-receipt schemas;
- project/worker/agent/capability authority boundaries;
- security, redaction, cursor sync, idempotency, and audit rules;
- fixture packs for both Wayfarer and Content Blooms.

### CR-1 — Read-only responsive prototype

- All Projects scope;
- Needs Your Attention;
- Active Projects;
- Running Now;
- Blockers;
- Workers and Agents;
- Recent Activity;
- Wayfarer and Content Blooms project drill-downs;
- mobile, keyboard, light, and dark verification.

Use synthetic data. A Content Blooms fixture should include a transcription on
the Mac, a generation job on the VPS/provider path, a customer-input blocker,
and a draft awaiting review. It must not include real transcript or draft text.

### CR-2 — Persistence and simulator

- Control Room PostgreSQL schema and migrations;
- generic projection tables and adapter registry;
- cursor-based sync and append-only audit;
- deterministic job/worker simulator;
- worker allocation modes and explainable scheduling simulation;
- contract, tenancy, idempotency, and adapter-offline tests;
- at least one unlike Wayfarer and Content Blooms fixture in permanent tests.

## Stop after CR-2

Do not connect production credentials, modify Content Blooms, schedule real
Unreal renders, or implement direct cross-project commands as part of this
handoff. Return the repository URL, contract version, migration summary,
fixture examples, verification results, and the exact read-adapter endpoints
expected from Content Blooms.

Content Blooms will then implement its read-only `CB-CR-1` adapter against the
working Control Room contract. Controlled retry/pause/priority/worker-preference
commands follow only after read synchronization and redaction tests pass.

## Non-negotiable boundaries

- Content Blooms PostgreSQL remains authoritative for customers, recordings,
  transcripts, voices, knowledge, recipes, content, review, and learning.
- Wayfarer keeps authority over builds, shots, renders, QC, approvals, and
  media artifacts through its domain pack.
- Control Room stores sanitized operational projections, not customer content.
- A machine, worker runtime, and Hermes agent are distinct identities.
- Control Room never reuses Hermes/A2A credentials as worker credentials.
- Content Blooms retains its own PostgreSQL lease engine; Control Room may
  request an operation through an API but never edits its workflow tables.
- Raw media and large artifacts remain in approved R2/local storage.
- Every command is scoped, version-checked, idempotent, and audited.
- No public inbound ports are required on the Mac or Windows PC.

## Completion signal

CR-2 is ready for Content Blooms integration when one private Control Room can
show both synthetic projects, distinguish all workers and agents, explain a
simulated blocker/allocation choice, survive an offline adapter, and prove that
no transcript, prompt, draft body, raw media, or domain secret entered its
database or logs.
