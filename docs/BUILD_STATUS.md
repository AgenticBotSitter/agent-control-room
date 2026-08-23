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
| CR-4Q through CR-10 | Not started | Phased build plan |

## Active block

```text
Completed: CR-4D — Tamper-evident audit chain, configuration validation, and safe operational errors
Delivered: canonical per-tenant/month audit hash chains, replay-safe append, durable chain heads, provider-neutral anchor records, projection-store integration, secret-safe errors, and fail-closed production configuration validation
Validation: TypeScript, lint, migration verification, and 40-test suite pass locally; production build and rendered-route tests remain required before merge
Open risks: Real PostgreSQL role/concurrency/crash rehearsal and external anchor publisher remain required; provider-specific Cloudflare/WebAuthn/node authentication remains intentionally adapter-scoped
Decision-log changes: none; implementation follows accepted CR-3 decisions
```

## Parallel build lane

The private GitHub repository is the temporary coordination plane until Control Room can schedule itself. Bounded implementation, fixtures, tests, platform probes, documentation, and UI work may be assigned to Hermes agents through work-packet issues. Codex/Sol remains responsible for architecture, security boundaries, acceptance criteria, and review of every returned pull request.

Local models are registered as `provisional` until the repository qualification pack establishes which task classes they can perform reliably. A model is not treated as equivalent to Luna, Terra, or Sol based on parameter count or reputation alone.

## Next block

```text
Block: CR-4Q — Independent security and data-integrity review
Set model: gpt-5.6-sol
Set reasoning effort: max
Why: review must challenge the completed implementation independently before additional capability expands the attack surface
Expected output: bounded findings report, fixes for accepted high/medium findings, and a real-PostgreSQL rehearsal plan
Stop before: CR-5 live-environment readiness work
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
