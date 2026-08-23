# Control Room build status

**Updated:** 2026-08-22  
**Purpose:** Single human-readable handoff showing what finished and which Codex model/effort to select next.  
**Authority:** Detailed acceptance remains in `CR3_BUILD_PLAN.md`; this file is the current summary.

## Current position

| Milestone | Status | Evidence |
|---|---|---|
| CR-0 founding contract | Complete | Founding contract and versioned project-adapter contract |
| CR-1 responsive read-only prototype | Complete | Portfolio, project, and worker fixture surfaces |
| CR-2 persistence and simulator | Complete | PostgreSQL-compatible migrations, projection store, scheduler tests |
| Research gates | Complete for architecture | Research synthesis; live acceptance checks carried into implementation |
| CR-3 architecture package | Complete and owner-accepted | CR-3 index and decision package |
| CR-4A canonical contracts | Complete | Domain types, validators, JSON Schema, state machines, authority-containment tests |
| CR-4B transactional persistence | Complete | Migrations 0003/0004, canonical store, bounded inbox failure handling, at-least-once delivery proof, qualification reviews |
| CR-4C through CR-10 | Not started | Phased build plan |

## Active block

```text
Completed: CR-4B — PostgreSQL repositories and transactional lifecycle
Delivered: normalized canonical schema, tenant-bound lineage, optimistic transitions, atomic job claims, monotonic attempts/lease epochs/checkpoints, renewal/expiry, bounded poison-message handling, inbox/outbox, idempotent execution, retry/recovery/dead-letter flow, acknowledgement-loss redelivery proof, and review hardening
Validation: TypeScript clean; 30/30 tests passed; four-migration verification passes with 40 tables
Open risks: Disposable real-PostgreSQL rehearsal remains required before live deployment; CR-4C must add identity, authorization, policy, approval verification, digest verification, and redaction
Decision-log changes: none; implementation follows accepted CR-3 decisions
```

## Parallel build lane

The private GitHub repository is the temporary coordination plane until Control Room can schedule itself. Bounded implementation, fixtures, tests, platform probes, documentation, and UI work may be assigned to Hermes agents through work-packet issues. Codex/Sol remains responsible for architecture, security boundaries, acceptance criteria, and review of every returned pull request.

Local models are registered as `provisional` until the repository qualification pack establishes which task classes they can perform reliably. A model is not treated as equivalent to Luna, Terra, or Sol based on parameter count or reputation alone.

## Next block

```text
Block: CR-4C — Identity, authorization, policy, approval, digest verification, and redaction
Set model: gpt-5.6-sol
Set reasoning effort: xhigh
Why: this becomes the central privilege and data-exposure boundary before any node or adapter can connect
Expected output: scoped identities/roles, deterministic policy decisions, exact-operation approval primitives, digest verification, safe errors, and boundary redaction tests
Stop before: CR-4D audit-chain and operational-error implementation
```

## Update rule

At the end of every completed or blocked build block:

1. update the phase table;
2. record delivered modules and validation evidence;
3. retain open risks and decision-log changes;
4. set exactly one active/next block;
5. name its exact model and reasoning effort;
6. state any owner input or external permission required;
7. do not advance when the completion gate failed.

The model recommendation is revalidated at each phase boundary because available Codex models may change during the build.
