# CR-5C effect admission, in-progress, and ambiguity contract dossier

**Status:** Complete 2026-08-23
**Worker route:** Marvin / macOS Mac mini / Hermes (ox-alpha) — documentation-only design analysis; high-risk.
**Purpose:** Close CON F4: define candidate durable state/receipt contracts that prevent concurrent duplicate effects while retaining honest ambiguity after crash. Compares three admission approaches; specifies transitions, durable records, keys, and receipt safety for every crash window. No implementation, no final design selection.
**Repo state:** current `main` post-#33 merge.

**Citation aliases:** LIFECYCLE=#29 bridge-executor boundary analysis · ATX=#21 adversarial matrix · CON=#33 contradiction review · TRACE=#27 · DOSSIER=#38 · INV=#20. `[P]`=**proposed here**; everything else cites existing reports/source.

## 0. The problem, stated precisely

CON F4: LIFECYCLE §3 window W2 says redelivery during handler execution ⇒ handler re-runs (at-least-once execution); ATX case 9b requires a duplicate arriving mid-execution to **serialize or refuse, never run concurrently**. These reconcile only if the executor claims the effect via durable state *before* returning from the gate — but LIFECYCLE's proposed `BridgeCommandGate` seam sits between `recordCommand` (`bridge.ts:167`) and `markInboundProcessed` (`bridge.ts:175`), where the inbox cannot yet distinguish "received" from "executing." Implement the gate naively and you satisfy #29 while violating 9b.

The invariant set any contract must hold (from ATX cases 9–10):
- **I1 Delivery dedup ≠ effect idempotency** — both hold independently (case 9 invariant).
- **I2 Concurrent duplicate ⇒ serialize/refuse** (9b), never parallel fire.
- **I3 Pre-effect crash ⇒ restart may re-authorize safely; nothing fired** (10a).
- **I4 Post-effect/pre-ack crash ⇒ classify `ambiguous`, raise attention, never silently re-fire** (10b).
- **I5 Ambiguous resolution requires destination evidence** — receipt for confirmed, safe code for failed (10c).
- **I6 No exactly-once external effects are ever claimed** — honest semantics = at-least-once delivery + idempotent destinations + honest ambiguity (case 10 invariant row).

## 1. Candidate admission approaches

### Approach J — Journal-level claim (effect claim row in the bridge SQLite journal)

Before dispatching to any handler, the gate inserts a claim row in the same transaction that marks the inbox processed: `effect_claims(claim_key PRIMARY KEY, state, claimed_at, owner_connection_id)` with states `claimed → executing → terminal{confirmed|failed|ambiguous}`. A second frame arriving whose derived `claim_key` hits an existing non-terminal row is refused/deferred at the gate (9b satisfied structurally).

| Dimension | Assessment |
|---|---|
| Concurrency | SQLite single-writer gives serialization for free within one process; the PK conflict IS the lock. Matches LIFECYCLE's one-journal-one-process topology [CR5B doc]. |
| Crash behavior | Claim row survives death. Restart sees `claimed/executing` rows ⇒ ambiguity classification input (see §3). |
| Fits seams | Natural extension of `bridge_commands` family; same WAL journal, same secret-guard chain (journal.ts:50/136 pattern). |
| Weakness | Only covers effects dispatched *through this node's journal*. An effect fired by a rogue process outside the bridge is invisible — acceptable, that adversary already owns the machine (THM T6 honesty, CON F7). |

### Approach E — Executor-level lock (in-process mutex/lease held by the executor)

The executor acquires an exclusive per-effect-key lock before firing and releases on terminal transition.

| Dimension | Assessment |
|---|---|
| Concurrency | Prevents concurrent fire *while the process lives* — but a lock dies with the process. After W2-crash, the new process holds no lock and the old holder's fate is unknown: the lock cannot answer "did it fire?" |
| Crash behavior | Weakest of the three: locks are memory, ambiguity needs disk. Must be paired with a durable record anyway — at which point it's J with extra steps. |
| Verdict | Viable only as an in-process fast-path optimization layered over a durable claim. Never the durability mechanism itself. |

### Approach D — Destination-idempotency-first (destination owns dedup via idempotency key)

Node sends every effect with a stable idempotency key; destination dedups. Node doesn't gate locally at all beyond delivery dedup.

| Dimension | Assessment |
|---|---|
| Concurrency | Correct *if* the destination honors keys — concurrent duplicates collapse to one effect server-side. This is how `executeIdempotent` works centrally (`delivery-store.ts:112-141`: INSERT-on-conflict + digest match + processing/completed status). |
| Crash behavior | Best honesty: post-effect/pre-ack crash is genuinely resolvable — query the destination with the key; its answer converts ambiguity into fact. |
| Weaknesses | (1) Requires every destination to support idempotency — unverifiable assumption for arbitrary executors (INV A4 string-equality gap shows even destinations are loosely typed today). (2) Destination queries need connectivity — offline nodes can't resolve ambiguity (ATX 12c context). (3) Key reuse across retries must be exact; key regeneration on retry recreates the duplicate problem. |
| Verdict | The right *resolution* mechanism, wrong as the sole *admission* mechanism. |

### Synthesis the comparison forces

J for admission (durable, local, structural 9b), D for resolution (destination truth converts ambiguity), E demoted to optional in-process optimization inside J. This mirrors the fleet-wide philosophy already in CR-5B/CR-4B: local durable records decide what to do next; external confirmations upgrade beliefs; nothing claims more certainty than evidence supports.

## 2. Transitions and durable records per scenario `[P]`

Durable record (bridge journal, new table family): `effect_claims(claim_key PK, message_id, job_id, attempt_id, idempotency_key, operation_digest, state CHECK IN ('claimed','executing','confirmed','failed','ambiguous'), claimed_at, updated_at, destination_receipt_digest?, safe_failure_code?)`. States mirror `effectIntentTransitions` (`state-machines.ts:74-82`) so classification logic stays symmetric with central records. `message_id` here is the **delivery-dedup secondary key** (see §3) — the PK is the effect-scoped `claim_key`.

| Scenario | Transition path | Durable record after | Receipt/outcome |
|---|---|---|---|
| Normal execute | claimed→executing→confirmed | terminal row + destinationReceiptDigest | ack normal |
| Duplicate delivery, original terminal | no new claim; gate sees terminal row | unchanged | ack duplicate; **replay stored result as idempotent outcome** (9c) |
| **Fresh-message re-offer of same effect** (new messageId, same jobId/attemptId/operationDigest) | derived `claim_key` matches existing row ⇒ refused/deferred at gate despite the fresh messageId | first row untouched | same disposition as concurrent duplicate — effect-scoped key makes this structurally identical to 9b |
| Concurrent duplicate mid-executing (9b) | second frame refused at gate | first row untouched `executing` | defer disposition (LIFECYCLE §5) or refuse-receipt `effect_in_progress` |
| Pre-effect crash (10a): death between claimed and executing-start | restart finds `claimed`, no executing evidence | re-dispatch under SAME claim_key | safe re-authorize (nothing fired) — I3 |
| Post-effect/pre-ack crash (10b): death during executing | restart finds `executing`, cannot know if fired | state→**ambiguous**, attention raised | never re-fire; await resolution — I4 |
| Retry after ambiguous | NO automatic retry from ambiguous | stays ambiguous | operator/server resolution only per policy |
| Operator resolves w/ destination receipt (10c) | ambiguous→confirmed | receipt digest stored | outcome reported upstream |
| Operator resolves w/ verified non-execution | ambiguous→failed | safeFailureCode stored | honest failure recorded |
| Ambiguous→cancelled | allowed by existing table | terminal cancelled | audit trail complete |

Key rule: **restart-time classification is mechanical**: `claimed`+no-executing-marker ⇒ safe re-dispatch; `executing` ⇒ ambiguous unconditionally (no heuristics, no "it probably didn't finish" — I4 admits no guessing).

## 3. Uniqueness / idempotency keys `[P]`

- **`claim_key` = sha256(nodeId ‖ jobId ‖ attemptId ‖ operationDigest)** — one claim per *effect* (node, job, attempt, operation), NOT per delivered message. **Message ID is a delivery-dedup secondary key only** (it collapses transport-level redelivery of the same frame); it must never scope the effect claim. A message-scoped claim key (`sha256(nodeId ‖ messageId)`) fails the at-least-once contract: a server legitimately re-offering the same effect under a fresh messageId after a retry/timeout derives a new claim key and slips past the gate — exactly the duplicate-effect hole this dossier exists to close.
- **`idempotency_key` = server-provided when present** (job/lease bodies carry identity), else derived identically to `claim_key`: `sha256(nodeId ‖ jobId ‖ attemptId ‖ operationDigest)`. Passed to destination verbatim so Approach-D resolution works when destinations support it. Digest-binding follows the INV D2 precedent (`digest.ts:67+`).
- **Never regenerate keys on retry** — regeneration is indistinguishable from a new effect to the destination.
- **Receipt safety:** stored receipts keep digests only (`destination_receipt_digest`); full receipts follow ATX case-11 rules (safe vocabulary, secret-guard before persistence).

## 4. What cannot be proven without the destination (honesty section)

- Whether an `executing` effect actually fired externally after a mid-flight crash — unknowable locally, ever. Hence I4/I6: ambiguity is a *terminal-honest* state, not a failure of design.
- Whether a refused/duplicate outcome matched what the destination actually did on a concurrent race — node-side serialization prevents *our* duplicates; it says nothing about other actors hitting the same destination concurrently. Destination-side idempotency (D) is the only defense there, and only where supported.
- Exactly-once anything. The contract's promise is: no concurrent self-inflicted duplicates (9b ✓), no silent re-fires (10b ✓), provable outcomes where destinations cooperate (10c ✓), honest ambiguity everywhere else.

## 5. Map to source seams and test categories

| Contract element | Seam today | Change class |
|---|---|---|
| Gate disposition gains `serialize/refuse` alongside execute/deny/defer | LIFECYCLE §5 `BridgeCommandGate.review` (proposed seam) | extend proposed interface `[P]` |
| `effect_claims` table | none — `bridge_commands` has queued/handled/rejected only (journal.ts:274 CHECK) | new schema addition (same packet family as TRACE J-2) |
| Ambiguity classification on restart | `unresolvedAttempts()` returns leased/running/waiting (journal.ts:179-188) but knows nothing of effects | extend recovery scan to consult effect_claims |
| Terminal-state symmetry | `effectIntentTransitions` incl. executing→ambiguous→confirmed/failed (state-machines.ts:77-79); destinationReceipt/safeFailureCode fields exist (`types.ts:154-155`) | reuse verbatim — local records mirror central shape (OPTS review-symmetry principle) |
| Idempotent result replay | `executeIdempotent` INSERT-conflict + digest-match pattern (delivery-store.ts:112+) | pattern precedent for 9c replay path |
| Secret guard on all new persistence | assertNoSecretMaterial chain (journal.ts:50/136/169) | mandatory on effect_claims writes |

Test categories: unit seeds now for transition/classification logic (acceptance-plan U9/U10); property test that claim_key derivation is collision-stable under fuzzed inputs; integration for 9b serialization and 9c replay; kill-boundary rehearsals for each §2 crash row (CR-5Q scope per acceptance-plan impossibility table). No exactly-once claims anywhere in test naming or assertions — packet acceptance requirement honored.

**Symbolic falsification test — fresh-message re-offer `[P]`** (required by audit §10): given an effect with terminal claim row keyed `sha256(N‖J‖A‖D)`, present a NEW frame with a fresh messageId M′ but identical (nodeId=N, jobId=J, attemptId=A, operationDigest=D). Assert: the gate derives the SAME claim_key, finds the terminal row, and refuses/defers rather than executing. The test fails symbolically under any message-scoped key derivation (`sha256(N‖M′)` ≠ `sha256(N‖M)` ⇒ new claim ⇒ duplicate execution) — this is precisely the defect class the effect-scoped key exists to eliminate.

**Retention/GC of terminal claims `[P]`** (decision required, duration NOT invented here): terminal rows (`confirmed`/`failed`/`ambiguous`/`cancelled`) are permanent by default in this contract, which grows the journal without bound. A bounded retention policy is REQUIRED before implementation: Codex must decide (a) the retention window or count bound for terminal claim records, (b) whether GC is periodic-delete vs rolling-partition, and (c) whether expired terminal rows leave a compact tombstone digest (to keep answering duplicate/re-offer probes honestly) or are dropped outright (accepting that very old re-offers re-execute — a policy trade, not a technical given). Non-terminal rows are never GC'd. This decision is deliberately left open here per packet scope; shipping without it would embed unbounded journal growth.

## 6. Left to Codex

Final approach selection (dossier recommends the J-admission + D-resolution composition); whether `refuse` vs `defer` is the right 9b gate disposition (refuse is louder, defer is gentler — policy choice); ambiguous-effect policy defaults per risk tier (`ambiguousEffectPolicy` precedent types.ts:89 suggests attention for all tiers initially); whether effect_claims belongs in bridge journal vs a sibling store if LIFECYCLE's v2 executor-daemon evolution is chosen; **terminal-claim retention/GC policy** (§5 — window/bound, GC mechanism, tombstone-vs-drop trade).

## Method note

All seams line-verified against current main (`journal.ts:134-188,190+,274`; `state-machines.ts:74-82`; `types.ts:143-156`; `delivery-store.ts:112-141`). F4 read in full and addressed head-on (§0). Every proposal labeled `[P]`; no exactly-once language anywhere; delivery and effect idempotency kept separate per acceptance requirements. Selection explicitly deferred.
