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
| CR-6D services, schedules, incidents, and reconciliation | Complete for effect-free implementation | Recurrence and IANA/DST handling, idempotent occurrence/outbox persistence, safe desired/observed reconciliation, incident correlation/remedies/recovery, and `CR6D_ACCEPTANCE.md` |
| CR-6E portfolio, fleet, attention, and owner-focus surfaces | Ready for owner acceptance | Protected tenant-bound dashboard projections, safe Owner Focus, responsive fixture boundaries, and `CR6E_ACCEPTANCE.md` |
| CR-6Q fleet/scheduler architecture review | Complete | Clean replacement review accepted from jobber #157/PR #158; maximum signal lifetime and terminated-reservation replay findings remediated; `CR6Q_ACCEPTANCE.md` |
| CR-7 foundation and Hermes adapter | CR-7A accepted for pinned zero-tool lifecycle; approval response remains observe-only | Strict harness contracts, migration 0020, replay-safe run/event persistence, Session Watch read source, pinned Hermes manifest/compatibility gate, sanitized gateway fixtures, read-only serve projection, provider-backed start/steer/cancel/usage/resume evidence, and a fail-closed lifecycle client; `CR7A_ACCEPTANCE.md` |
| CR-7B Codex worker adapter | Effect-free Mac adapter, durable credential-broker core, and qualification-only isolated topology complete; native qualification blocked pending real OS/process/network deployment and review | Signed-binary manifest, authority-bound command planner, safe decoder/process/worktree/artifact lineage, accepted native negative evidence, at-most-once broker policy, private durable restart ledger, and fail-closed remote-executor topology; `CR7B_ACCEPTANCE.md` |
| CR-7C through CR-10 | Dependency-mapped; not started | `CONTROL_ROOM_COMPLETION_PROGRAM.md` |

## Active block

CR-7A is accepted at Hermes package `0.20.6`, installed Git revision `5fc308a70719a83cccdbba4c0e39c23f5a8239d5`. A disposable provider-backed run proved zero-tool start, structured streaming, steer, interrupt, usage, persistence, restart, and resume. The lifecycle client fails before prompt submission unless the exact pin, disposable profile/workspace, ignored context files, zero MCP servers, and the valid zero-tool `context_engine` selection are attested and observed. Approval response remains observe-only. CR-6E owner acceptance, real per-platform supervisor rehearsals, and the unresolved macOS CR-5C.9H native gate remain separate owner-controlled gates.

```text
Active: CR-7B OS-isolated broker/remote-executor launcher and requalification; CR-6E owner acceptance remains a separate owner gate
Delivered this boundary: CR5D-INT-001 through CR5D-INT-003 add exact admission binding, cancellation, restart-safe lifecycle delivery, and transactional artifact lineage. CR5D-STOR-001 and STOR-002 provide bounded memory storage plus a private disposable-filesystem adapter with no-overwrite atomic publication, exact hashing, capacity bounds, root identity checks, and honest crash ambiguity. CR5D-CTRL-001 is complete: authenticated version-bound requests, atomic audit plus outbox, strict protocol bodies, acknowledgement-gated central state, durable node-local drain/quarantine before reply, closed admission/renewal gates, restart-safe cancellation obligations, and signed semantic acknowledgement delivery. CR5D-UI-004 is complete: worker views use explicit node identity/version/state, operation requests require confirmation and distinguish requested from signed-node-confirmed state, and synthetic timeline plus artifact lineage render producer claims separately from independent verification. CR5D-REC-001 proves an actual abrupt process exit after local completion, SQLite recovery of execution and lineage, resend after a second interruption before acknowledgement, authenticated retirement, and no post-ack redelivery. CR5D-ACC-001 now proves raw signed job-event authentication before central persistence, exact lease/lineage binding, replay-safe central evidence and lifecycle projections, and a completed node-local record that remains durable until a signed central acknowledgement is received. CR6A-CON-001 is complete, and the static systemd, launchd, and Windows wrapper templates plus an effect-free conformance and diagnostic harness are implemented. The harness validates value-free platform markers, fixed runtime/config placeholders, privilege/restart/cancellation assertions, and safe status codes without reading local configuration or operating a native supervisor. CR6C-CON-001 is established: deterministic allocation rejects hard-ineligible work before scoring, applies fair-share debt without bypassing safety, uses stable tie-breaking, and returns reasoned decisions rather than dispatch authority. CR6C now also includes a 1,440-minute starvation guard; fail-closed exclusive, preferred, shared, opportunistic, manual, and draining placement rules; unified cost, privacy, quality, deadline, and maintenance constraints; atomic expiring resource reservations; releasable project-budget reservations; bottleneck reporting; and seeded order, fairness, starvation, exclusion, replay, capacity, and recovery tests registered in the normal full suite. CR6E-CON-001 is underway: a versioned, redacted operator-surface contract now governs fleet/bottleneck summaries, Action Inbox records, legal responses, evidence references, delivery state, and Owner Focus intent. Its durable store enforces tenant separation and exact command replay without emitting a scheduler or external-effect request.
Validation completed: live CR-7A qualification observed a provider-backed streamed turn, queued steering, confirmed interrupt, 1,035 reported tokens on one completed correction call, and idle resume with four persisted messages after restart; both creation and resume reported zero tools. The focused suite passes 11/11. The full suite runs 351 tests: 349 pass, zero fail, and two platform-specific tests intentionally skip. Type checking, lint, production build, two rendered-route tests, and migration verification through 0020/68 tables pass. The disposable profile and workspace were removed after capture. See `CR7A_ACCEPTANCE.md`.
CR-7B effect-free, negative-evidence, credential-broker, and isolated-topology validation now passes 23/23 focused tests. The combined full suite runs 374 tests: 372 pass, zero fail, and two platform-specific tests intentionally skip. Type checking, focused lint, production build, two rendered-route tests, and migration verification through 0020/68 tables pass. Safe patch publication, identity-bound worktree cleanup, sanitized native negative evidence, short-lived broker permits, atomic provider-call spending, conflict/expiry/limit enforcement, cancellation closure, private durable storage, prompt-canary exclusion, restart-to-ambiguity recovery, and qualification-only broker/remote-executor topology denial are implemented. ADR-049 and `CR7B_CREDENTIAL_BROKER_CONTRACT.md` freeze the security boundary. The first authorized provider call remains the only native Codex call; its temporary targets were removed. See `CR7B_ACCEPTANCE.md`.
Open risks: native Codex saved authentication is readable across the tested read-only command boundary, so native execution remains disabled. The effect-free broker ledger prevents replay and survives restart, but a real launcher has not yet proved separate OS identity, broker-private credential/provisioning/settlement access, local IPC authentication, or broker-only provider egress. Approval response is unqualified; Hermes empty/invalid toolset configuration fails open to configured tools, so the exact valid zero-tool selection and observed count are mandatory; raw Hermes config display may expose credential-bearing MCP URLs and is forbidden from adapter capture. The macOS provider remains unqualified and its original failure stage remains unproven; atomic platform file semantics, live DNS/TLS and rebinding, timer/cancellation transport, live cost/resource consumption, process-kill rehearsal, destination evidence, approval issuance, disposable deployment, and CR-6 service isolation remain explicit downstream gates
Owner input required now: none for effect-free broker-process design and review. A further native provider call is forbidden until the OS/process/network boundary is implemented and reviewed, then requires new exact disposable-scope approval. Owner review of the protected dashboard according to `CR6E_ACCEPTANCE.md` remains pending. Exact approval remains required before installing or starting a native service, enabling effect-capable Hermes tools or MCP servers, a new macOS native attempt, new credentials, live artifact namespaces, deployment, live integration, or consequential effects
Decision-log changes: ADR-049 requires an at-most-once credential broker; ADR-048 adopts one completion graph and continuous production queue; ADR-039 and ADR-047 remain controlling
```

## Parallel build lane

The owner accepted Agent Build System V2 on 2026-08-25. The private GitHub repository remains the temporary coordination plane, but legacy open issues are inventory rather than a claimable queue. New delegated work requires a Codex-authored frozen wave and `ready` task capsule. A globally serialized issue-command controller atomically claims eligible platform-labelled jobbers, enforces route concurrency, returns only untouched work to ready, moves attempted failures to Codex triage, and releases capacity on submission so agents can continue without waiting for review. Worker results target `integration/<block>`, pass automated intake, receive independent verification where required, and are promoted by Codex into one block pull request. Direct-to-main, self-assigned, stale, overlapping, or manifest-free worker results are quarantined before semantic review.

The first intake pilot quarantined open PRs #127–#129 because they predated V2, targeted `main`, lacked capsules/result manifests, and proposed work outside the active CR-5C.9H gate. PR #83 is superseded by later accepted qualification evidence. This coordination change does not authorize or consume a macOS native attempt.

Wave `CR5C9H-CAL-1` is closed by owner direction with all four report PRs unmerged. No more qualification-only or instruction-following jobbers will be issued. Route eligibility is now decided per real bounded task using its contract, risk, platform, tools, and independent-review requirements; passing a calibration report is not a prerequisite for useful implementation work.

The first real V2 implementation wave is `CR5D-EXEC-1`, pinned to product base `b523d9f6237b7d4161b70cf7524a8f683b683ac4` and integration branch `integration/cr5d-synthetic-executor-1`. It contains five independent T1 production slices: the deterministic synthetic executor, the text artifact/claim-bound evidence builder, the artifact evidence card, the synthetic lifecycle timeline, and the worker operation request panel. All are effect-free code plus tests, require independent-route verification, and may proceed in parallel without asserting that the unresolved CR-5C.9H macOS gate passed. Promotion to `main` remains a Codex integration and security decision.

`docs/CONTROL_ROOM_COMPLETION_PROGRAM.md` records the complete CR-5D through CR-10 dependency graph. Codex keeps the ready frontier stocked and reviews/integrates results in batches. Workers claim directly from GitHub, may hold several independent jobs within the route limit, and continue after submission without waiting for owner relay or per-job review. Only real product work is published.

## Next block

```text
Block: CR-7B — native broker/remote-executor launcher and isolation proof
Set model: gpt-5.6-sol
Set reasoning effort: high
Why: The durable broker and a fail-closed qualification-only topology gate are implemented, but native execution cannot pass until a real launcher proves the broker and remote executor actually run under separate identities with no credential, ledger, local-command fallback, or direct-provider path from the executor.
Expected output: reviewed Mac launcher and owner-attended setup procedure, effect-free conformance first, then separately authorized native unreadability/egress proof and sanitized start/event/usage/cancel/explicit-ID-resume evidence. The experimental split remains ineligible for production.
Stop before: another native provider call until credential isolation exists and receives separate review; workspace-write, production worktree mutation, credential disclosure, deployment, or consequential external effect.
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
