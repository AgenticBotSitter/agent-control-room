# Control Room build status

**Updated:** 2026-08-24
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
| CR-5C node-local policy and effect enforcement | In progress — CR-5C.1 through CR-5C.8 complete; CR-5C.9 implemented; CR-5C.9H harness merged and real-host qualification active | Canonical policy/effect enforcement plus explicit platform private-key providers and repository-owned qualification harnesses |
| CR-5D through CR-10 | Not started | Phased build plan |

## Active block

```text
Active: CR-5C.9H real-host qualification — merged PR #94 provides the repository-owned execute-only harness; issue #101 routes attended macOS execution, issue #102 routes fresh Windows DPAPI execution after accepted #87 cleanup, and issue #103 routes Linux execution
Delivered this boundary: the pinned harness and accepted independent Linux contradiction review are merged; macOS prompt/stale-queue operator rules are explicit; DPAPI safe-category compression is documented; and Windows-compatible symlink/reparse refusal has a deterministic regression test
Validation evidence: TypeScript and lint pass; focused platform tests are 15/15; full repository suite is 141/141; the local real Windows CurrentUser DPAPI harness passes; issue contracts #101–#103 validate canonically with no contract errors
Open risks: fresh real macOS/Linux observations, fresh Windows report after #87 cleanup, atomic platform file-open/delete semantics, live DNS/TLS enforcement and rebinding rehearsal, actual timer/cancellation transport, approval consumption, cost/concurrency reservation, process-kill/concurrency rehearsal, destination evidence adapters, approval issuance, and CR-6 service isolation remain explicit gates
Decision-log changes: ADR-038 fixes explicit platform-bound boot-unlock providers, forbids silent fallback and secret argv/environment sources, and keeps native host behavior unqualified until observed
```

## Parallel build lane

The private GitHub repository is the temporary coordination plane until Control Room can schedule itself. Bounded implementation, fixtures, tests, platform probes, documentation, and UI work may be assigned to Hermes agents through work-packet issues. Codex/Sol remains responsible for architecture, security boundaries, acceptance criteria, and review of every returned pull request.

Local models are registered as `provisional` until the repository qualification pack establishes which task classes they can perform reliably. A model is not treated as equivalent to Luna, Terra, or Sol based on parameter count or reputation alone.

## Next block

```text
Block: CR-5C.9H — Complete execute-only host qualifications and review every returned report
Set model: gpt-5.6-sol
Set reasoning effort: high
Why: host qualification is security-sensitive; effect cardinality, native evidence, prompt behavior, cleanup, report consistency, and first-attempt history must be checked before accepting any platform claim
Expected output: accepted macOS, Windows, and Linux qualification reports produced only by the pinned repository harness, with exact cleanup and actual-ledger proof
Stop before: production identities, persistent services/tasks, unattended deployment, CR-6 packaging, or representing a blocked/failed native observation as passing
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
