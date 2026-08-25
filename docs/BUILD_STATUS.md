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
| CR-5C node-local policy and effect enforcement | In progress — CR-5C.1 through CR-5C.8 complete; CR-5C.9 implemented; Windows and Linux providers qualified; macOS native qualification blocked | Canonical policy/effect enforcement plus explicit platform private-key providers and repository-owned qualification harnesses |
| CR-5D through CR-10 | Not started | Phased build plan |

## Active block

```text
Active: CR-5C.9H macOS qualification diagnosis — Linux issue #120 / PR #122 is accepted and merged with 11/11 encrypted-file cases passing; macOS issue #121 / PR #123 preserves an owner-attended `unavailable_platform` outcome and is awaiting its single report-only evidence correction
Delivered this boundary: accepted Linux fresh-checkout preparation plus real-host encrypted-file qualification; repository-level Codex guidance, delegation-review skill, and a GitHub-based Mac Codex handoff are prepared for cross-machine continuation
Validation evidence: Linux stage zero reported setup required, one offline frozen-lockfile install succeeded with lifecycle scripts denied, runtime readiness passed, the single native attempt passed 11/11 cases, and exact scratch absence was verified; macOS preparation/readiness and cleanup passed but the native harness returned `unavailable_platform`
Open risks: the corrected macOS evidence must resolve reporting contradictions before merge; macOS adapter/fixture prompt behavior remains unqualified; atomic platform file-open/delete semantics, live DNS/TLS enforcement and rebinding rehearsal, actual timer/cancellation transport, approval consumption, cost/concurrency reservation, process-kill/concurrency rehearsal, destination evidence adapters, approval issuance, and CR-6 service isolation remain explicit gates
Decision-log changes: no new normative platform decision; ADR-039 remains controlling while negative macOS evidence is diagnosed
```

## Parallel build lane

The private GitHub repository is the temporary coordination plane until Control Room can schedule itself. Bounded implementation, fixtures, tests, platform probes, documentation, and UI work may be assigned to Hermes agents through work-packet issues. Codex/Sol remains responsible for architecture, security boundaries, acceptance criteria, and review of every returned pull request.

Local models are registered as `provisional` until the repository qualification pack establishes which task classes they can perform reliably. A model is not treated as equivalent to Luna, Terra, or Sol based on parameter count or reputation alone.

## Next block

```text
Block: CR-5C.9H — accept the corrected macOS negative-evidence report, diagnose the two-prompt/`unavailable_platform` path from source and bounded evidence, and design the smallest architect-owned correction before any retest
Set model: gpt-5.6-sol
Set reasoning effort: high
Why: Linux is now qualified; macOS reached the real native boundary but failed, and the next decision affects credential-store behavior, prompt timing, exit propagation, and retry authority
Expected output: one accepted negative-evidence report, a source-backed macOS failure diagnosis, a tested architect patch if warranted, and a separately authorized fresh host retest only after that patch is merged
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
