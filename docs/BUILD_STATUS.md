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
| CR-5C node-local policy and effect enforcement | In progress — CR-5C.1 through CR-5C.4 complete | Canonical contracts, protected stores, persistent security state, pure authority intersection, and coarse denial receipts |
| CR-5D through CR-10 | Not started | Phased build plan |

## Active block

```text
Active: CR-5C — CR-5C.1 through CR-5C.4 complete; durable local admission/refusal is next
Delivered this boundary: total deterministic ceiling/lease/request intersection, complete delegated-authority chain checks, local executor-owned effect classification, locally recomputed operation identity, exact cost/capability/time/concurrency limits, scoped approval signature verification, and strict coarse denial receipts
Validation evidence: `tests/node-policy-evaluator.test.ts` exercises containment and privacy adversarial cases; the full 97-test suite, lint, type check, regenerated policy schema, 51-table migration verification, production build, and rendered HTML tests pass; implementation report is `docs/CR5C4_AUTHORITY_INTERSECTION.md`
Open risks: durable admission and approval consumption, coordinated rollback by a same-UID/host attacker, platform key providers, expiry monitoring, effect claims/ambiguity, real filesystem and DNS/TLS guards, process-kill/concurrency rehearsal, and approval issuance remain explicit later gates
Decision-log changes: ADR-033 makes external-effect classification and normalized operation identity local rather than server-controlled
```

## Parallel build lane

The private GitHub repository is the temporary coordination plane until Control Room can schedule itself. Bounded implementation, fixtures, tests, platform probes, documentation, and UI work may be assigned to Hermes agents through work-packet issues. Codex/Sol remains responsible for architecture, security boundaries, acceptance criteria, and review of every returned pull request.

Local models are registered as `provisional` until the repository qualification pack establishes which task classes they can perform reliably. A model is not treated as equivalent to Luna, Terra, or Sol based on parameter count or reputation alone.

## Next block

```text
Block: CR-5C.5 — Durable bridge-to-executor admission and refusal
Set model: gpt-5.6-sol
Set reasoning effort: xhigh
Why: policy decisions must survive duplicate delivery and crashes before any later executor can treat an admission as authoritative
Expected output: versioned local admission records, unique stable request/operation identity, durable accepted/refused state, exact decision-digest replay, bridge command-handler seam, coarse refusal emission, restart/duplicate/conflict tests, and no executor dispatch before commit
Stop before: executor side effects, durable effect claims/pre-effect markers, approval issuance, native platform providers, live timers, real filesystem/network I/O guards, or live Control Room deployment
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
