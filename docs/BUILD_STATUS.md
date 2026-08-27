# Control Room build status

**Updated:** 2026-08-27
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
| CR-5D and CR-5Q | Complete for the effect-free local vertical slice | Synthetic executor, evidence builder, coordinator, private disposable storage, restart-safe SQLite delivery, authenticated central intake, atomic lifecycle/evidence projection, signed acknowledgement retirement, abrupt-exit recovery, and remediated adversarial review |
| CR-6B discovery, telemetry, capability, benchmark, and eligibility core | Complete for effect-free implementation | Versioned normalized signals, authenticated ingress, tenant-bound append-only history/current facts with separate per-probe/per-benchmark current records, safe current/history reads, freshness/trust/resource gates, and full verification evidence; native host evidence remains owner-controlled |
| CR-6C deterministic scheduling and reservations | Complete for effect-free implementation | Deterministic scheduler, starvation bound, placement and policy gates, availability, atomic resource/budget reservations, reconciliation, bottleneck impact, named simulations, concurrency acceptance, and `CR6C_ACCEPTANCE.md` |
| CR-6D services, schedules, incidents, and reconciliation | Active | Contract and implementation begin next |
| CR-6E through CR-10 | Dependency-mapped; implementation not started | `CONTROL_ROOM_COMPLETION_PROGRAM.md` |

## Active block

The effect-free CR-6B fleet-signal core is complete. It carries versioned normalized discovery, telemetry, capability, and benchmark claims through raw-frame authentication; exact tenant/node/sequence binding; append-only history; multi-subject current facts; safe reads; and deterministic freshness, trust, scratch, capability, and benchmark-environment eligibility gates. Retention is intentionally evidence-preserving: no fleet history is deleted without an explicit owner retention policy. CR-6A's normative contract, value-free systemd/launchd/Windows templates, and static conformance/diagnostics are complete; its real per-platform supervisor rehearsals remain explicit owner-controlled gates. The unresolved macOS CR-5C.9H native gate remains an explicit owner-controlled security risk; it is not converted into a pass and is not allowed to halt effect-free implementation.

```text
Active: CR-6D services, schedules, incidents, and reconciliation
Delivered this boundary: CR5D-INT-001 through CR5D-INT-003 add exact admission binding, cancellation, restart-safe lifecycle delivery, and transactional artifact lineage. CR5D-STOR-001 and STOR-002 provide bounded memory storage plus a private disposable-filesystem adapter with no-overwrite atomic publication, exact hashing, capacity bounds, root identity checks, and honest crash ambiguity. CR5D-CTRL-001 is complete: authenticated version-bound requests, atomic audit plus outbox, strict protocol bodies, acknowledgement-gated central state, durable node-local drain/quarantine before reply, closed admission/renewal gates, restart-safe cancellation obligations, and signed semantic acknowledgement delivery. CR5D-UI-004 is complete: worker views use explicit node identity/version/state, operation requests require confirmation and distinguish requested from signed-node-confirmed state, and synthetic timeline plus artifact lineage render producer claims separately from independent verification. CR5D-REC-001 proves an actual abrupt process exit after local completion, SQLite recovery of execution and lineage, resend after a second interruption before acknowledgement, authenticated retirement, and no post-ack redelivery. CR5D-ACC-001 now proves raw signed job-event authentication before central persistence, exact lease/lineage binding, replay-safe central evidence and lifecycle projections, and a completed node-local record that remains durable until a signed central acknowledgement is received. CR6A-CON-001 is complete, and the static systemd, launchd, and Windows wrapper templates plus an effect-free conformance and diagnostic harness are implemented. The harness validates value-free platform markers, fixed runtime/config placeholders, privilege/restart/cancellation assertions, and safe status codes without reading local configuration or operating a native supervisor. CR6C-CON-001 is established: deterministic allocation rejects hard-ineligible work before scoring, applies fair-share debt without bypassing safety, uses stable tie-breaking, and returns reasoned decisions rather than dispatch authority. CR6C now also includes a 1,440-minute starvation guard; fail-closed exclusive, preferred, shared, opportunistic, manual, and draining placement rules; unified cost, privacy, quality, deadline, and maintenance constraints; atomic expiring resource reservations; releasable project-budget reservations; bottleneck reporting; and seeded order, fairness, starvation, exclusion, replay, capacity, and recovery tests registered in the normal full suite.
Validation completed: CR-6C passed type checking, lint, 287 full-suite tests with zero failures and two intentional skips, the production/rendered build, migrations 0001 through 0015, seeded scheduling properties, the named failure-mode catalogue, restart reconciliation, and 16-way capacity contention. See `CR6C_ACCEPTANCE.md`.
Open risks: the macOS provider remains unqualified and its original failure stage remains unproven; atomic platform file semantics, live DNS/TLS and rebinding, timer/cancellation transport, approval consumption, live cost/resource consumption, process-kill rehearsal, destination evidence, approval issuance, disposable deployment, and CR-6 service isolation remain explicit downstream gates
Owner input required now: none for effect-free CR-6D contract and implementation work; exact approval remains required before installing or starting a native service, a new macOS native attempt, credentials, live artifact namespaces, deployment, live integration, or consequential effects
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
Block: CR-6D — services, schedules, incidents, and reconciliation
Set model: gpt-5.6-terra
Set reasoning effort: high
Why: This phase is stateful but contract-driven and builds on the completed scheduler boundaries.
Expected output: versioned desired/observed service contract, recurrence with timezone/DST handling, idempotent occurrence creation and outbox dispatch, incident derivation/correlation/recovery projections, transactional persistence, crash replay, and boundary acceptance tests.
Stop before: installing or starting a native service, dispatching a real external job, changing credentials or production identities, deployment, or consequential external effects without exact owner authority.
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
