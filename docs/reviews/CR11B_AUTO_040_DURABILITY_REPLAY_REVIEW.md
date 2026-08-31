# CR11B-AUTO-040 Durability and Replay Independent Review

**Review mode:** independent review, report-only, zero repair budget

**Review date:** 2026-08-30

## Exact review binding

- Exact candidate: `c16939f6e57a7c34eeffeeae9ffdd3b97430b824`
- Exact parent: `d8f115393b79bf52d2c541407fceca9e9ce54e5a`
- Branch: `codex/cr11b-auto-040-no-relay-simulation`
- Observed merge base: `d8f115393b79bf52d2c541407fceca9e9ce54e5a`

`HEAD` and the merge base matched the requested commits before review. The working tree was clean at preflight. A separate concurrent reviewer later created `docs/reviews/CR11B_AUTO_040_SECURITY_AUTHORITY_REVIEW.md`; this reviewer did not read or modify it. This durability/replay report is the only repository path written by this reviewer.

## Findings

### AUTO040-DR-001 — High — the exported durable store can mint authenticated success without the composed path or fake delivery

`ReadyFrontierNoRelayStoreV1.begin` accepts caller-supplied materialization, promotion, handoff, delivery, and request digests without verifying authenticated receipts or requiring a coordinator-held operation capability. `complete` then accepts any syntactically valid acknowledgement digest and turns a `delivery_started` row into `acknowledged_repository_simulation`. Both methods are public, and the class is re-exported from the public ready-frontier index.

A disposable direct-store probe created a syntactically valid start, called `begin`, and called `complete` with `sha256Digest({ fabricated: true, noFakeWasCalled: true })`. It constructed zero fake-delivery objects and made zero coordinator calls. The store returned a digest- and HMAC-authenticated `acknowledged_repository_simulation` run. `buildReadyFrontierActivationPacketV1` accepted that run and returned an authenticated `blocked_pending_production_proof` packet.

The packet remains non-authorizing, so this does not create a production effect. It does invalidate the candidate's evidence boundary: the authenticated run does not prove that accepted AUTO-020 materialization, accepted AUTO-030 promotion, the durable pre-contact marker, and the fixed fake acknowledgement actually formed the claimed composed path. The store itself supplies authenticity to arbitrary caller assertions. The acceptance claim that only a genuinely acknowledged repository-simulation run can produce the packet therefore is not established.

Relevant implementation: `src/ready-frontier/v1/no-relay-store.ts:105-155`, `src/ready-frontier/v1/no-relay.ts:213-234`, and the public export in `src/ready-frontier/v1/index.ts`.

### AUTO040-DR-002 — Medium — begin replay ignores changed requested state

The exact-replay comparison in `begin` checks the start object's fields but never compares the requested `state` argument. The probe first recorded the run as `delivery_started`, then replayed the identical start with requested state `expired_before_delivery`. The store returned `replayed: true` and the prior `delivery_started` state instead of rejecting `replay_drift`.

The inverse direction is likewise possible. State determines whether fake contact is permitted, so it is a material start fact, not ignorable replay metadata. This contradicts the exact-replay and changed-start-fact claims.

Relevant implementation: `src/ready-frontier/v1/no-relay-store.ts:105-129`.

### AUTO040-DR-003 — Medium — the ledger authenticates start states that contradict the deadline

Neither `begin` nor `validateRunState` binds the initial state to `startedAt` versus `deliveryDeadline`. The probe successfully stored `expired_before_delivery` with `startedAt` at `2026-08-30T18:04:07.000Z` and the deadline at `2026-08-30T18:08:00.000Z`; the authenticated ledger therefore claimed the delivery window had expired nearly four minutes early. The symmetric false `delivery_started` at or after the deadline is also admitted by the same validation path.

The coordinator currently chooses the intended state, but the ledger contract expressly claims that the store verifies state transitions and chronology. Because the store is an exported mutation boundary and signs its result, coordinator-only correctness is insufficient for durable evidence.

Relevant implementation: `src/ready-frontier/v1/no-relay-store.ts:105-129` and `src/ready-frontier/v1/no-relay.ts:87-107`.

### AUTO040-DR-004 — Low — terminal completion can exceed the configured record ceiling

`maximumRecords` is checked only before inserting a version-1 row. Completion always adds version 2 without checking or reserving capacity. With `maximumRecords = 3`, the probe recorded and completed one run (two rows), began a second run (three rows), then completed it; the ledger contained four rows. This does not create authority, but it makes the configured durability bound untrue and can defeat an operator's storage limit under repeated begin/complete work.

Relevant implementation: `src/ready-frontier/v1/no-relay-store.ts:119-129` and `132-155`.

## Positive and limited evidence

- The dedicated AUTO-040 suite passed 13/13. It demonstrates one coordinator path, exact terminal replay, thrown/malformed/early/late handling, deadline expiry, restart reconciliation without second fake contact, row tamper detection, complete-database rollback detection, fixed-fake rejection, and non-authorizing projection/packet behavior.
- The combined CR11B suite passed 80/80, including the accepted AUTO-020 and AUTO-030 boundaries.
- Type checking passed.
- Inspection confirmed exact SQLite objects and definitions are checked, the database and parent directory are owner/private checked before use, rows and whole-state metadata are authenticated, an external checkpoint is compared on every verification, and complete rollback mismatches fail closed in the focused test.
- The coordinator records `delivery_started` before its single captured fake call. Exact terminal replay, caught fake failure, and restart-unsettled paths do not call the fake a second time in the tested coordinator configuration.
- Same-coordinator overlap has an in-memory guard. Multi-process convergence, hosted persistence, production checkpoint custody, and a real consumer remain explicitly unproved; no broader claim is inferred here.
- The checkpoint is advanced before SQLite commit. A commit failure after checkpoint advance leaves a mismatch and fails closed on reuse rather than silently replaying. This favors integrity over availability and does not repair the alternate mutation seam in `AUTO040-DR-001`.

## Commands and observed evidence

| Command or probe | Result |
|---|---|
| `git rev-parse HEAD` | `c16939f6e57a7c34eeffeeae9ffdd3b97430b824` |
| `git merge-base HEAD d8f115393b79bf52d2c541407fceca9e9ce54e5a` | exact parent `d8f115393b79bf52d2c541407fceca9e9ce54e5a` |
| `git diff --check d8f1153..c16939f` | passed |
| `node --import tsx --test tests/ready-frontier-no-relay.test.ts` | 13/13 passed |
| `node --import tsx --test tests/ready-frontier-contract.test.ts tests/ready-frontier-durable-store.test.ts tests/ready-frontier-integration.test.ts tests/ready-frontier-automation.test.ts tests/ready-frontier-promotion.test.ts tests/ready-frontier-no-relay.test.ts tests/ready-frontier-view.test.tsx` | 80/80 passed |
| `./node_modules/.bin/tsc --noEmit` | passed |
| Disposable direct-store probe using repository `tsx`, a private temporary directory, SQLite, and in-memory rollback checkpoints | accepted a fabricated acknowledgement with zero coordinator/fake calls; produced an authenticated blocked packet; accepted changed begin state as replay; authenticated early false expiry; stored 4 rows with a 3-record limit |

No provider, credential, native, network, deployment, GitHub mutation, production effect, implementation repair, acceptance/status/decision edit, or commit occurred.

## Required disposition

The passing coordinator tests establish useful no-retry behavior, but the durable evidence boundary can independently authenticate fabricated success and does not enforce exact start-state replay or deadline chronology. The exact candidate cannot be accepted as durable/replay-safe until those findings are remediated and reviewed by a different independent reviewer.

REJECTED_DURABILITY_REPLAY_FINDINGS
