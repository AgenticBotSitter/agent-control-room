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
| CR-5C node-local policy and effect enforcement | In progress — CR-5C.1 complete | Frozen contract plus signed/canonical schemas, complete lease authority, generated JSON Schema, and adversarial fixtures |
| CR-5D through CR-10 | Not started | Phased build plan |

## Active block

```text
Active: CR-5C — CR-5C.1 canonical security contracts complete; stateful enforcement has not started
Delivered this boundary: signed owner ceiling, owner-root trust bundle, approval attestation, normalized request/decision and executor capability, safe receipt vocabulary, canonical target grammars, complete node-targeted authority on offers/grants/renewals, generated JSON Schema, and adversarial fixtures
Validation evidence: `tests/node-policy-contract.test.ts`, regenerated domain/protocol/policy schemas, type/lint/full test/migration/build gates; implementation report is `docs/CR5C1_CANONICAL_SECURITY_CONTRACTS.md`
Open risks: store persistence and monotonic adoption, protected-store platform implementations, Linux unwrap-secret delivery, policy intersection, effect admission, real timer behavior, real DNS/TLS enforcement, process-kill/concurrency rehearsal, and approval issuance remain explicit later gates
Decision-log changes: ADR-023 through ADR-030 freeze the CR-5C security boundary
```

## Parallel build lane

The private GitHub repository is the temporary coordination plane until Control Room can schedule itself. Bounded implementation, fixtures, tests, platform probes, documentation, and UI work may be assigned to Hermes agents through work-packet issues. Codex/Sol remains responsible for architecture, security boundaries, acceptance criteria, and review of every returned pull request.

Local models are registered as `provisional` until the repository qualification pack establishes which task classes they can perform reliably. A model is not treated as equivalent to Luna, Terra, or Sol based on parameter count or reputation alone.

## Next block

```text
Block: CR-5C.2 — Protected-store and clock interfaces with deterministic test doubles
Set model: gpt-5.6-sol
Set reasoning effort: high
Why: this separates private signing, server trust, approval trust, and time before any stateful security code depends on them
Expected output: `NodePrivateKeyStore`, `ServerTrustStore`, `ApprovalTrustStore`, `Clock`, key references/availability, fail-closed provider selection, deterministic in-memory fakes, and lifecycle/secret-nonexposure tests
Stop before: native platform providers, ceiling/trust persistence, authority evaluation, executor admission, effects, or live integrations
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
