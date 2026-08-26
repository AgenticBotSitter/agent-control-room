# Control Room build status

**Updated:** 2026-08-25
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
| CR-5D through CR-10 | Not started | Phased build plan |

## Active block

The 2026-08-24 operator-workflow amendment changes upcoming CR-5D, CR-6E, CR-7B/7E, and CR-8B/8C deliverables. It does not reopen the accepted CR-4 security core or change the active CR-5C.9H qualification gate.

```text
Active: CR-5C.9H fresh macOS diagnostic retest design and owner authorization — issue #121 is closed after PR #123 merged the corrected partial/blocked report; the provider remains unqualified after the owner-attended harness returned `unavailable_platform`
Delivered this boundary: PR #130 fixed canonical macOS scratch-path and safe runtime-warning test behavior; PR #131 added fixed, non-sensitive `qualificationStage` values to macOS error JSON without changing provider, ACL, timeout, prompt, retry, or fallback behavior
Validation evidence: the architect branches passed TypeScript, ESLint, focused qualification tests, and the full suite with 143 passed, 0 failed, and 2 platform skips; post-merge TypeScript and the focused suite passed with 17 passed, 0 failed, and 2 platform skips; no native or Keychain effect was run
Open risks: the original failure stage and two-prompt chronology remain unproven; strict `CONTROL_ROOM_MACOS_ALLOW_ONCE_WINDOW` conformance and the launcher shell-exit discrepancy remain unresolved; atomic platform file-open/delete semantics, live DNS/TLS enforcement and rebinding rehearsal, actual timer/cancellation transport, approval consumption, cost/concurrency reservation, process-kill/concurrency rehearsal, destination evidence adapters, approval issuance, and CR-6 service isolation remain explicit gates
Owner input required: explicitly authorize a new bounded owner-attended macOS work order and its single fresh native attempt; no prior authorization carries forward
Decision-log changes: no new normative platform decision; ADR-039 remains controlling and the macOS provider status remains unqualified
```

## Parallel build lane

The owner accepted Agent Build System V2 on 2026-08-25. The private GitHub repository remains the temporary coordination plane, but legacy open issues are inventory rather than a claimable queue. New delegated work requires a Codex-authored frozen wave and `ready` task capsule. A globally serialized issue-command controller atomically claims eligible platform-labelled jobbers, enforces route concurrency, returns only untouched work to ready, moves attempted failures to Codex triage, and releases capacity on submission so agents can continue without waiting for review. Worker results target `integration/<block>`, pass automated intake, receive independent verification where required, and are promoted by Codex into one block pull request. Direct-to-main, self-assigned, stale, overlapping, or manifest-free worker results are quarantined before semantic review.

The first intake pilot quarantined open PRs #127–#129 because they predated V2, targeted `main`, lacked capsules/result manifests, and proposed work outside the active CR-5C.9H gate. PR #83 is superseded by later accepted qualification evidence. This coordination change does not authorize or consume a macOS native attempt.

Wave `CR5C9H-CAL-1` is closed by owner direction with all four report PRs unmerged. No more qualification-only or instruction-following jobbers will be issued. Route eligibility is now decided per real bounded task using its contract, risk, platform, tools, and independent-review requirements; passing a calibration report is not a prerequisite for useful implementation work.

The first real V2 implementation wave is `CR5D-EXEC-1`, pinned to product base `b523d9f6237b7d4161b70cf7524a8f683b683ac4` and integration branch `integration/cr5d-synthetic-executor-1`. It contains two independent T1 production slices under the architect-frozen CR-5D contract: the deterministic synthetic executor and the text artifact/claim-bound evidence builder. Both are effect-free code plus tests, require independent-route verification, and may proceed in parallel without asserting that the unresolved CR-5C.9H macOS gate passed. Promotion to `main` remains a Codex integration decision subject to the active completion gate.

## Next block

```text
Block: CR-5C.9H — design and review a fresh owner-attended macOS qualification packet against merged main, then stop for explicit owner authorization before its single native attempt
Set model: gpt-5.6-sol
Set reasoning effort: high
Why: the negative report and bounded stage diagnostics are merged, but the exact failing native stage remains unknown and only a newly authorized owner-attended attempt can resolve it
Expected output: one execute-only work order pinned to the merged harness, explicit owner authorization, one bounded JSON outcome containing `qualificationStage` on failure, exact cleanup evidence, and a separate review disposition
Stop before: launching the attended harness without fresh owner authorization, changing Keychain ACL/policy, using Always Allow, retrying the native attempt, production identities, persistent services/tasks, unattended deployment, CR-6 packaging, or representing a blocked/failed native observation as passing
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
