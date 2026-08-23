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
| CR-4C security core | Complete | Identities/grants, deterministic policy, canonical digests, redaction, strong approval consumption, database-role script |
| CR-4D audit and operations core | Complete | Migration 0006, per-tenant audit chain, safe errors, fail-closed runtime configuration |
| CR-4Q independent review | Complete | 11 remediated high/medium findings, migration 0007, 46-test adversarial suite |
| CR-5A node protocol and identity | Complete | Versioned schemas, Ed25519 enrollment/authentication, durable replay, migration 0008, 58-test suite |
| CR-5B portable bridge core | Complete | Outbound connection state machine, heartbeat, acknowledgements, SQLite journal/recovery, backpressure, migration 0009 |
| CR-5C through CR-10 | Not started | Phased build plan |

## Active block

```text
Completed: CR-5B — Portable bridge core, connection loop, heartbeat, and local journal
Delivered: injected outbound transport/signer/trust seams, deterministic connection and heartbeat state machine, exact duplicate acknowledgement, SQLite WAL journal, crash/restart reconciliation, bounded backpressure, reconnect replay filtering, and queued-command boundary
Validation: 66/66 tests, TypeScript, lint, nine-migration verification (51 tables), production build, and two rendered-route checks pass
Open risks: Native protected key storage and server trust persistence, node-local authority ceilings, command/effect enforcement, real WebSocket/TLS packaging, and real PostgreSQL/kill rehearsal remain explicit CR-5C/5Q/CR-6 gates
Decision-log changes: ADR-022 distinguishes exact delivery duplicates from conflicting replays
```

## Parallel build lane

The private GitHub repository is the temporary coordination plane until Control Room can schedule itself. Bounded implementation, fixtures, tests, platform probes, documentation, and UI work may be assigned to Hermes agents through work-packet issues. Codex/Sol remains responsible for architecture, security boundaries, acceptance criteria, and review of every returned pull request.

Local models are registered as `provisional` until the repository qualification pack establishes which task classes they can perform reliably. A model is not treated as equivalent to Luna, Terra, or Sol based on parameter count or reputation alone.

## Next block

```text
Block: CR-5C — Node-local policy ceilings, key-store interface, and job/effect enforcement
Set model: gpt-5.6-sol
Set reasoning effort: xhigh
Why: this is the independent containment boundary against an over-authorized or compromised Control Room server
Expected output: immutable local ceiling contract, platform key-store/trust interfaces, authority intersection and expiry/target/tool/network/cost checks, denial receipts, and ambiguous-effect protections
Stop before: CR-5D synthetic executor, artifact flow, and worker UI
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
