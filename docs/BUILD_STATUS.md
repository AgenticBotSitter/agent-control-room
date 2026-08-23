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
| CR-4D through CR-10 | Not started | Phased build plan |

## Active block

```text
Completed: CR-4C — Identity, authorization, policy, approval primitives, digests, and redaction
Delivered: provider-neutral verified identity interface, single-use owner bootstrap, scoped grants, append-only policy decisions, canonical digest verification, secret rejection/redaction, exact strong-factor approval consumption, and production database-role definitions
Validation: TypeScript and lint clean; 36/36 tests passed; five-migration verification passes with 44 tables; production build and rendered-route tests pass
Open risks: Database-role and approval/revocation concurrency behavior still require disposable real-PostgreSQL rehearsal; provider-specific Cloudflare/WebAuthn/node authentication remains intentionally adapter-scoped
Decision-log changes: none; implementation follows accepted CR-3 decisions
```

## Parallel build lane

The private GitHub repository is the temporary coordination plane until Control Room can schedule itself. Bounded implementation, fixtures, tests, platform probes, documentation, and UI work may be assigned to Hermes agents through work-packet issues. Codex/Sol remains responsible for architecture, security boundaries, acceptance criteria, and review of every returned pull request.

Local models are registered as `provisional` until the repository qualification pack establishes which task classes they can perform reliably. A model is not treated as equivalent to Luna, Terra, or Sol based on parameter count or reputation alone.

## Next block

```text
Block: CR-4D — Audit hash chain, configuration validation, and operational errors
Set model: gpt-5.6-terra
Set reasoning effort: high
Why: contracts and security decisions are settled; this is substantial multi-file implementation with deterministic gates
Expected output: tamper-evident per-tenant audit chain, external-anchor interface, fail-closed production configuration, and redacted safe operational errors
Stop before: CR-4Q independent security/data-integrity review
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
