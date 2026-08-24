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
| CR-5C node-local policy and effect enforcement | In progress — CR-5C.1/5C.2 complete | Canonical security schemas plus separated protected-store/clock contracts, explicit provider selection, fakes, and bridge signing seam |
| CR-5D through CR-10 | Not started | Phased build plan |

## Active block

```text
Active: CR-5C — CR-5C.1 and CR-5C.2 complete; persistent monotonic security state is next
Delivered this boundary: separate private-signing/server-trust/approval-trust interfaces, opaque key references and availability, fixed safe errors, explicit no-downgrade provider selection, injected system/test clocks, deterministic non-production fakes, and a key-ID-bound CR-5B frame signer
Validation evidence: `tests/node-protected-stores.test.ts` plus policy/protocol/bridge regression suites and the full repository gate; implementation report is `docs/CR5C2_PROTECTED_STORE_CONTRACTS.md`
Open risks: ceiling/trust persistence and monotonic adoption, protected-store platform implementations, Linux unwrap-secret delivery, policy intersection, effect admission, real timer behavior, real DNS/TLS enforcement, process-kill/concurrency rehearsal, and approval issuance remain explicit later gates
Decision-log changes: ADR-031 forbids silent private-key-provider downgrade and unsafe unwrap-secret transports
```

## Parallel build lane

The private GitHub repository is the temporary coordination plane until Control Room can schedule itself. Bounded implementation, fixtures, tests, platform probes, documentation, and UI work may be assigned to Hermes agents through work-packet issues. Codex/Sol remains responsible for architecture, security boundaries, acceptance criteria, and review of every returned pull request.

Local models are registered as `provisional` until the repository qualification pack establishes which task classes they can perform reliably. A model is not treated as equivalent to Luna, Terra, or Sol based on parameter count or reputation alone.

## Next block

```text
Block: CR-5C.3 — Crash-safe ceiling and server-trust persistence
Set model: gpt-5.6-sol
Set reasoning effort: xhigh
Why: rollback resistance, owner-root pinning, atomic bundle adoption, and recovery behavior are the persistent containment boundary against a compromised server
Expected output: crash-safe local ceiling/trust repositories, independent monotonic high-water state, owner-pin verification seams, irreversible key lifecycle checks, recovery fixtures, and tamper/rollback tests
Stop before: native platform private-key providers, authority evaluation, executor admission, effects, timers, target guards, or live integrations
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
