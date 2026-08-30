# CR11B-AUTO-040 Durability Remediation Independent Rereview

**Review mode:** independent rereview, report-only, zero repair budget

**Review date:** 2026-08-30

## Exact review binding

- Exact remediation HEAD: `8344dd698bc8bc2786b611fdb246e9e5aca3dc4e`
- Exact parent and rejected candidate: `c16939f6e57a7c34eeffeeae9ffdd3b97430b824`
- Branch: `codex/cr11b-auto-040-no-relay-simulation`
- Observed merge base with the rejected candidate: `c16939f6e57a7c34eeffeeae9ffdd3b97430b824`
- Immutable durability/replay report SHA-256: `ac2fbad63eed913ea95b185e35d1b905b72614b643ce6b6a80eb97d9a8019515`

`HEAD`, parent, branch, merge base, and report digest matched the requested remediation boundary. The working tree was clean at preflight. This reviewer made no implementation, acceptance, status, or prior-review change; this rereview is the only repository path written.

## Finding-by-finding disposition

### AUTO040-DR-001 — closed

The exported store no longer permits a caller to mint authenticated success. `begin`, `complete`, and `recoverUnsettled` all require the exact object held in a module-private `WeakMap`; the exact registered and frozen coordinator alone receives that capability. The coordinator invokes captured base implementations rather than mutable instance methods, and the store and its prototype are frozen.

The disposable reviewer probe called `begin` first with no capability and then with a fabricated frozen null-prototype object. Both calls returned `policy_denied`, and the authenticated ledger remained at zero rows. The focused gate separately exercises a direct `complete` call and receives `policy_denied`. Activation eligibility is also tied by object identity to the exact frozen acknowledged run returned by the composed coordinator, so a separately reconstructed authenticated run cannot create an activation packet.

Relevant implementation: `src/ready-frontier/v1/no-relay-store.ts:130-162`, `src/ready-frontier/v1/no-relay-store.ts:310-326`, and `src/ready-frontier/v1/no-relay-store.ts:328-391`.

### AUTO040-DR-002 — closed

`begin` now reads and verifies the version-1 row and compares its recorded initial state with the requested replay state before accepting replay. It continues to compare every original start fact. A changed `delivery_started`/`expired_before_delivery` request therefore reaches `replay_drift` inside the authorized path; an external direct caller cannot reach that comparison because the capability check fails first.

Relevant implementation: `src/ready-frontier/v1/no-relay-store.ts:130-147`.

### AUTO040-DR-003 — closed

Authenticated run construction and parsing now enforce start/deadline chronology. `expired_before_delivery` is rejected when `startedAt` precedes `deliveryDeadline`, and every other run state is rejected when `startedAt` is at or after the deadline. Completion chronology additionally rejects updates before start and acknowledgements before start or after deadline.

The disposable reviewer probe reproduced both original false-state shapes. False early expiry and false delivery-started-at-deadline each returned `replay_drift`; neither produced a ledger row.

Relevant implementation: `src/ready-frontier/v1/no-relay.ts:86-110` and `src/ready-frontier/v1/no-relay-store.ts:151-185`.

### AUTO040-DR-004 — closed for the stated repository simulation boundary

The store now reserves two record slots before a new `delivery_started` row and one slot before an immediately expired row. It also rechecks the one-row terminal addition in `complete`. The coordinator checks the complete required capacity before materialization or promotion, so the focused maximum-three-record case leaves the first completed run at two rows and rejects the second run before another canonical job or handoff is created.

The configured ceiling therefore remains true for the reviewed single-process repository simulation. Hosted and multi-process concurrency remain explicitly unqualified residual boundaries and are not inferred as accepted here.

Relevant implementation: `src/ready-frontier/v1/no-relay-store.ts:125-157`, `src/ready-frontier/v1/no-relay-store.ts:180-185`, and `src/ready-frontier/v1/no-relay-store.ts:412-417`.

## Commands and observed evidence

| Command or probe | Observed result |
|---|---|
| `git rev-parse HEAD` | `8344dd698bc8bc2786b611fdb246e9e5aca3dc4e` |
| `git rev-parse HEAD^` | `c16939f6e57a7c34eeffeeae9ffdd3b97430b824` |
| `git merge-base HEAD c16939f6e57a7c34eeffeeae9ffdd3b97430b824` | exact rejected candidate `c16939f6e57a7c34eeffeeae9ffdd3b97430b824` |
| `shasum -a 256 docs/reviews/CR11B_AUTO_040_DURABILITY_REPLAY_REVIEW.md` | `ac2fbad63eed913ea95b185e35d1b905b72614b643ce6b6a80eb97d9a8019515` |
| `node scripts/qualification/platform-key-store-stage-zero.mjs --platform macos` | `ready_for_runtime_check` |
| `node --import tsx --test tests/ready-frontier-no-relay.test.ts` | 14/14 passed |
| `pnpm test:cr11b` | 81/81 passed |
| `pnpm check` | passed |
| Disposable direct-store and chronology probe using repository `tsx`, a private temporary directory, SQLite, the fixture run key, and an in-memory rollback checkpoint | no-capability `begin`: `policy_denied`; fabricated-capability `begin`: `policy_denied`; false early expiry: `replay_drift`; false late delivery start: `replay_drift`; final ledger rows: 0 |

The focused evidence also passed exact terminal replay, restart recovery without a second fake contact, changed-request rejection, row-tamper detection, complete-database rollback detection, early/late acknowledgement handling, terminal capacity rejection before a second canonical mutation, blocked activation packet behavior, and structural absence of real effect clients. No provider, credential, native, network, GitHub mutation, deployment, production consumer, or external effect was used.

## Required disposition

All four numbered durability/replay findings in the immutable rejection report are remediated at exact HEAD `8344dd698bc8bc2786b611fdb246e9e5aca3dc4e`. This accepts only the effect-free, single-process repository simulation slice and does not authorize production activation or broaden any residual boundary in the acceptance record.

ACCEPTED_DURABILITY_REMEDIATION
