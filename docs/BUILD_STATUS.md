# Control Room build status

**Updated:** 2026-08-23
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
| CR-5C node-local policy and effect enforcement | In progress — CR-5C.1 through CR-5C.5 complete | Canonical contracts, protected stores, authority intersection, denial privacy, and durable commit-before-ack admission |
| CR-5D through CR-10 | Not started | Phased build plan |

## Active block

```text
Active: CR-5C — CR-5C.1 through CR-5C.5 complete; execution-time expiry enforcement is next
Delivered this boundary: filesystem-backed local admission ledger, stable operation/admission identities, fresh-message delivery aliases, immutable exact-decision replay, one-accepted-admission constraint, deterministic coarse refusal seam, and bridge commit-before-process-before-ack ordering
Validation evidence: `tests/node-admission.test.ts` and bridge crash-order tests cover restart, aliases, conflicts, original-time replay, refusal privacy, and handler failure/retry; the full 101-test suite, lint, type check, 51-table migration verification, production build, and rendered HTML tests pass; implementation report is `docs/CR5C5_DURABLE_ADMISSION.md`
Open risks: approval consumption, cost/concurrency reservation, expiry monitoring, effect claims/pre-effect ambiguity, coordinated rollback, platform key providers, real filesystem and DNS/TLS guards, process-kill/concurrency rehearsal, and approval issuance remain explicit later gates
Decision-log changes: ADR-034 requires durable admission before inbox processing and acknowledgement and aliases fresh messages to stable operation identity
```

## Parallel build lane

The private GitHub repository is the temporary coordination plane until Control Room can schedule itself. Bounded implementation, fixtures, tests, platform probes, documentation, and UI work may be assigned to Hermes agents through work-packet issues. Codex/Sol remains responsible for architecture, security boundaries, acceptance criteria, and review of every returned pull request.

Local models are registered as `provisional` until the repository qualification pack establishes which task classes they can perform reliably. A model is not treated as equivalent to Luna, Terra, or Sol based on parameter count or reputation alone.

## Next block

```text
Block: CR-5C.6 — Execution-time expiry and cancellation state machine
Set model: gpt-5.6-sol
Set reasoning effort: xhigh
Why: authority that was valid at admission must not survive a deadline, renewal race, restart, or late server message and begin a new effect
Expected output: deterministic expiry events and attempt state transitions, earliest-effective-deadline calculation, no resurrection after expiry, cancellation requests for in-flight work, pre-effect recheck seam, fake-clock boundary tests, and durable restart classification
Stop before: actual executor side effects, durable effect claims/pre-effect markers, native live timers, approval issuance, platform key providers, real filesystem/network I/O guards, or live deployment
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
