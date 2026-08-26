# Control Room build status

**Updated:** 2026-08-26
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
| CR-3 operator-workflow amendment | Complete and owner-accepted | Zide/Devin comparison, ADR-040–ADR-045, Completion Gate, Action Inbox, harness-run, procedure/knowledge, and phase-plan amendments |
| CR-4A canonical contracts | Complete | Domain types, validators, JSON Schema, state machines, authority-containment tests |
| CR-4B transactional persistence | Complete | Migrations 0003/0004, canonical store, bounded inbox failure handling, at-least-once delivery proof, qualification reviews |
| CR-4C security core | Complete | Identities/grants, deterministic policy, canonical digests, redaction, strong approval consumption, database-role script |
| CR-4D audit and operations core | Complete | Migration 0006, per-tenant audit chain, safe errors, fail-closed runtime configuration |
| CR-4Q independent review | Complete | 11 remediated high/medium findings, migration 0007, 46-test adversarial suite |
| CR-5A node protocol and identity | Complete | Versioned schemas, Ed25519 enrollment/authentication, durable replay, migration 0008, 58-test suite |
| CR-5B portable bridge core | Complete | Outbound connection state machine, heartbeat, acknowledgements, SQLite journal/recovery, backpressure, migration 0009 |
| CR-5C node-local policy and effect enforcement | In progress — CR-5C.1 through CR-5C.8 complete; CR-5C.9 implemented; Windows and Linux providers qualified; macOS native qualification remains blocked after accepted negative evidence | Canonical policy/effect enforcement, explicit platform private-key providers, repository-owned qualification harnesses, and bounded macOS failure-stage diagnostics |
| CR-5D | In progress — local vertical acceptance complete; independent CR-5Q threat/recovery review next | Synthetic executor, evidence builder, coordinator, private disposable storage, restart-safe SQLite event/outbox/lineage/control delivery, authenticated central job-event intake, central lifecycle projection, signed acknowledgement retirement, integrated worker controls and evidence, abrupt-exit recovery, and deterministic tests |
| CR-6 through CR-10 | Dependency-mapped; implementation not started | `CONTROL_ROOM_COMPLETION_PROGRAM.md` |

## Active block

The effect-free active build lane is CR-5D. The unresolved macOS CR-5C.9H native gate remains an explicit owner-controlled security risk; it is not converted into a pass and is not allowed to halt unrelated effect-free product implementation.

```text
Active: CR-5D independent CR-5Q threat/recovery review
Delivered this boundary: CR5D-INT-001 through CR5D-INT-003 add exact admission binding, cancellation, restart-safe lifecycle delivery, and transactional artifact lineage. CR5D-STOR-001 and STOR-002 provide bounded memory storage plus a private disposable-filesystem adapter with no-overwrite atomic publication, exact hashing, capacity bounds, root identity checks, and honest crash ambiguity. CR5D-CTRL-001 is complete: authenticated version-bound requests, atomic audit plus outbox, strict protocol bodies, acknowledgement-gated central state, durable node-local drain/quarantine before reply, closed admission/renewal gates, restart-safe cancellation obligations, and signed semantic acknowledgement delivery. CR5D-UI-004 is complete: worker views use explicit node identity/version/state, operation requests require confirmation and distinguish requested from signed-node-confirmed state, and synthetic timeline plus artifact lineage render producer claims separately from independent verification. CR5D-REC-001 proves an actual abrupt process exit after local completion, SQLite recovery of execution and lineage, resend after a second interruption before acknowledgement, authenticated retirement, and no post-ack redelivery. CR5D-ACC-001 now proves raw signed job-event authentication before central persistence, exact lease/lineage binding, replay-safe central evidence and lifecycle projections, and a completed node-local record that remains durable until a signed central acknowledgement is received.
Validation required before promotion: Codex must complete the independent CR-5Q threat/recovery review.
Open risks: the macOS provider remains unqualified and its original failure stage remains unproven; atomic platform file semantics, live DNS/TLS and rebinding, timer/cancellation transport, approval consumption, cost/concurrency reservation, process-kill rehearsal, destination evidence, approval issuance, disposable deployment, and CR-6 service isolation remain explicit downstream gates
Owner input required now: none for effect-free CR-5D implementation or temp-directory storage tests; exact approval remains required before a new macOS native attempt, install, credential, live artifact namespace, disposable deployment, live integration, or consequential effect
Decision-log changes: ADR-048 adopts one completion graph and continuous production queue; ADR-039 and ADR-047 remain controlling
```

## Parallel build lane

The owner accepted Agent Build System V2 on 2026-08-25. The private GitHub repository remains the temporary coordination plane, but legacy open issues are inventory rather than a claimable queue. New delegated work requires a Codex-authored frozen wave and `ready` task capsule. A globally serialized issue-command controller atomically claims eligible platform-labelled jobbers, enforces route concurrency, returns only untouched work to ready, moves attempted failures to Codex triage, and releases capacity on submission so agents can continue without waiting for review. Worker results target `integration/<block>`, pass automated intake, receive independent verification where required, and are promoted by Codex into one block pull request. Direct-to-main, self-assigned, stale, overlapping, or manifest-free worker results are quarantined before semantic review.

The first intake pilot quarantined open PRs #127–#129 because they predated V2, targeted `main`, lacked capsules/result manifests, and proposed work outside the active CR-5C.9H gate. PR #83 is superseded by later accepted qualification evidence. This coordination change does not authorize or consume a macOS native attempt.

Wave `CR5C9H-CAL-1` is closed by owner direction with all four report PRs unmerged. No more qualification-only or instruction-following jobbers will be issued. Route eligibility is now decided per real bounded task using its contract, risk, platform, tools, and independent-review requirements; passing a calibration report is not a prerequisite for useful implementation work.

The first real V2 implementation wave is `CR5D-EXEC-1`, pinned to product base `b523d9f6237b7d4161b70cf7524a8f683b683ac4` and integration branch `integration/cr5d-synthetic-executor-1`. It contains five independent T1 production slices: the deterministic synthetic executor, the text artifact/claim-bound evidence builder, the artifact evidence card, the synthetic lifecycle timeline, and the worker operation request panel. All are effect-free code plus tests, require independent-route verification, and may proceed in parallel without asserting that the unresolved CR-5C.9H macOS gate passed. Promotion to `main` remains a Codex integration and security decision.

`docs/CONTROL_ROOM_COMPLETION_PROGRAM.md` records the complete CR-5D through CR-10 dependency graph. Codex keeps the ready frontier stocked and reviews/integrates results in batches. Workers claim directly from GitHub, may hold several independent jobs within the route limit, and continue after submission without waiting for owner relay or per-job review. Only real product work is published.

## Next block

```text
Block: CR-5Q — independent CR-5D threat and recovery review
Set model: gpt-5.6-sol
Set reasoning effort: max
Why: the completed local path crosses signature validation, replay state, durable evidence, lifecycle projection, and signed acknowledgement retirement; adversarial review needs maximum care at those boundaries.
Expected output: a documented pass or remediated findings proving no unauthenticated, conflicting, out-of-order, or acknowledgement-loss path can create false central success or prematurely retire node-local evidence.
Stop before: live deployment, a new macOS native attempt, credentials, production identities, unapproved external effects, treating producer claims as verification, or allowing client UI to decide node authority.
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
