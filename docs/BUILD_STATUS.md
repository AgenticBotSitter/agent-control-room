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
| CR-5C node-local policy and effect enforcement | In progress — CR-5C.1 through CR-5C.8 complete | Canonical contracts, durable admission/expiry, pinned targets, and restart-safe effect truth |
| CR-5D through CR-10 | Not started | Phased build plan |

## Active block

```text
Active: CR-5C — CR-5C.1 through CR-5C.8 complete; platform providers and manual qualification are next
Delivered this boundary: stable effect identity independent of delivery messages, live execution-authority derivation, atomic unique claims, exact pre-effect markers, fresh-message replay, restart-safe ambiguity, evidence-gated settlement, hash-checked history, and horizon-gated permanent terminal tombstones
Validation evidence: `tests/node-effect-claims.test.ts` covers identity changes, aliases, two-store serialization, authority and deadline rejection, marker binding, restart windows, ambiguity without automatic retry, destination evidence, terminal replay/compaction, unknown retention horizons, durable restart, and persisted tampering; the full repository gates pass; implementation report is `docs/CR5C8_EFFECT_CLAIMS.md`
Open risks: atomic platform file-open/delete semantics, live DNS/TLS enforcement and rebinding rehearsal, actual timer/cancellation transport, approval consumption, cost/concurrency reservation, coordinated rollback, native platform key providers, process-kill/concurrency rehearsal, destination evidence adapters, and approval issuance remain explicit later gates
Decision-log changes: ADR-037 makes effect identity independent of delivery, requires atomic pre-effect truth, forbids automatic ambiguity retry, and retains digest tombstones when horizons are unknown
```

## Parallel build lane

The private GitHub repository is the temporary coordination plane until Control Room can schedule itself. Bounded implementation, fixtures, tests, platform probes, documentation, and UI work may be assigned to Hermes agents through work-packet issues. Codex/Sol remains responsible for architecture, security boundaries, acceptance criteria, and review of every returned pull request.

Local models are registered as `provisional` until the repository qualification pack establishes which task classes they can perform reliably. A model is not treated as equivalent to Luna, Terra, or Sol based on parameter count or reputation alone.

## Next block

```text
Block: CR-5C.9 — Platform private-key providers and manual qualification rehearsals
Set model: gpt-5.6-sol
Set reasoning effort: xhigh
Why: private-key custody and service-context behavior differ materially across macOS, Windows, and headless Linux, and the frozen fail-closed provider-selection contract must be proven without exposing key bytes
Expected output: thin macOS Keychain and Windows DPAPI CurrentUser adapters, one explicit encrypted-file provider for headless Linux and portable fallback configuration, deterministic provider fakes, safe error taxonomy, no automatic downgrade, and bounded manual qualification packets for each real host
Stop before: unattended production deployment, actual executor side effects, destination-specific reconciliation, approval issuance UX, or claims that CI substitutes for native prompt/service-context rehearsals
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
