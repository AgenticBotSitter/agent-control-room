# CR-4B delivery failure-mode and test matrix — Hermes qualification evidence

Work packet: **CR-4B** · Task class: **qualification** · Risk: **low** · Evidence report only — implementation, tests, migrations, package files, existing documentation, GitHub settings, credentials, databases, and live systems untouched. No messages sent, no external effects invoked.

## Review metadata

| Field | Value |
|---|---|
| Worker route | Johnny5-or-another-Hermes-route / provisional — executed by **Hermes (this session) on Alastair's Mac mini**, the Marvin host machine |
| Harness | Hermes Agent session; git 2.50.1, pnpm 11.19.0, node v22.22.3; GitHub REST API via stored git credentials |
| Machine | Mac mini, macOS 26.6.2 |
| Review time | 2026-08-22, ~20:30–21:30 MDT |
| Inputs | `src/persistence/delivery-store.ts` (159 lines), `tests/canonical-persistence.test.ts` (226 lines) against `docs/CR3_PROTOCOLS_AND_EXTENSIONS.md` (§Standard envelope, §Node protocol › Delivery semantics, §Adapter conformance kit) and `docs/CR3_DATA_DURABILITY_AND_RECOVERY.md` (§Central persistence architecture, §Data acceptance tests) |
| Repo state reviewed | `main` @ `7ca6573`; supporting context consulted: `db/migrations/0003_canonical_domain_delivery.sql`, `src/persistence/database.ts` |

## Assumptions

1. Line references: `delivery-store.ts` cited as DS:Lnn, test file as T:Lnn, migration 0003 as SQL:Lnn.
2. "Concurrent" means two independent database sessions/transactions. The test suite runs on single-connection PGlite, which serializes transactions — interleaving at await points exercises guard logic but cannot prove lock behavior under true parallelism. Tests passing today therefore demonstrate logic-shape correctness, not concurrency proof. This limitation shapes several priorities below.
3. The at-least-once contract is taken as stated in CR-4B doc §Outbox: "Delivery is at least once. Destination idempotency or later effect reconciliation handles acknowledgement loss."
4. The sibling review (`CR4B_MARVIN_MIGRATION_CONSTRAINT_REVIEW.md`, PR #3) covers schema constraints; this report deliberately does not re-litigate those findings except where delivery behavior depends on them.

## Commands used

```bash
git clone … && git log --oneline          # pin main @ 7ca6573; API sweep: no other PR touches delivery review
pnpm install --frozen-lockfile
pnpm run db:verify                         # applied 0001/0002/0003; verified 40 tables on isolated PGlite
pnpm test                                  # 27 tests, 27 pass, 0 fail (includes canonical-persistence.test.ts)
pnpm run check                             # tsc --noEmit clean
```

Static analysis of DS + T against both CR-3 documents; no live system contacted.

---

## Reading key

- **Coverage:** ✅ tested · ⚠️ partial (mechanism exists, proof incomplete) · ❌ missing
- **Priority:** **P1** = close before any production data flows through delivery paths · **P2** = close before CR-4C exit or CR-5 rehearsal, whichever first · **P3** = hygiene/documentation
- Every case names the exact test that would close it.

---

## Failure-mode and test matrix

### 1. Duplicate delivery (same inbox message received twice)

- **Current coverage:** ✅ T:L177–178 — second `receive` of an identical envelope returns `replayed: true`; PK `(tenant_id, protocol, message_id)` (SQL:L255) is the dedup spine.
- **Expected invariant:** same message ID + same body digest ⇒ one durable inbox row, replay flag, no duplicate handling.
- **Missing test:** none at store level.
- **Priority:** —

### 2. Conflicting digests (message ID reused with different body)

- **Current coverage:** ✅ T:L179 — `receive` with swapped `bodyDigest` rejects (`/different body digest/`, DS:L41). Fail-closed, matching the CR-3 standard-envelope anti-replay intent.
- **Expected invariant:** a reused ID can never smuggle new content; the original row stays intact.
- **Missing test:** assert the original message remains processable after a rejected conflicting receive (the throw aborts the tx so it trivially holds — one line pins it).
- **Priority:** P3

### 3. Concurrent processing (two workers call `processOnce` simultaneously)

- **Current coverage:** ⚠️ DS:L49 takes `FOR UPDATE` on the inbox row and DS:L54 throws on durable `'processing'`, but no test drives two processors, and single-connection PGlite cannot exercise real row-lock contention.
- **Expected invariant:** exactly one handler execution; the loser observes `processed` and replays.
- **Missing test:** dual-session `processOnce` race on real PostgreSQL (CR-5 environment); interim, a serialized-interleaving test documenting the guard order (lock → status check → handler).
- **Priority:** P2

### 4. Handler rollback (handler throws mid-`processOnce`) — **the largest gap**

- **Current coverage:** ❌ no test makes a handler throw. Behavior by construction (DS:L47–68, one transaction): rollback restores prior status and even rolls back the `attempts+1` write.
- **Expected invariant vs reality:** crash-safe revert holds, but the design has **no bounded retry for the inbox**: `attempts` only ever counts successful runs (failures roll the increment back), `status='failed'` and `safe_failure_code` (SQL:L249, L254) are unreachable from any code path, and there is no inbox analog of outbox `maxAttempts`/`dead_letter`. A permanently poison message is retried forever with zero observable failure signal.
- **Missing tests:** (a) handler-throws ⇒ status still `received`, handler side-effects absent, `attempts` unchanged; (b) once a poison-parking policy exists: N consecutive failures ⇒ `status='failed'`, `safe_failure_code` recorded, reclaim only via explicit operator/recovery action.
- **Design decision required:** either wire the existing `failed` state into `processOnce` (commit the failure after the handler tx aborts, with its own attempt cap) or document inbox retries as caller-policy. Today it is neither implemented nor documented.
- **Priority:** **P1**

### 5. Process crash boundaries

- **Current coverage:** ⚠️ structural soundness is real — every delivery operation is a single transaction, so a crash before commit reverts completely; fresh `DeliveryStore`/`CanonicalStore` instances over the same database prove cross-client durability (T:L102–104, T:L183–185). No true SIGKILL-point test exists and PGlite cannot express one.
- **Expected invariant:** for every crash point (after claim, before handler, after handler, before ack, after ack) the system converges to at-least-once with no partial visible state.
- **Missing test:** CR-5 kill-point drill matrix on production-shaped PostgreSQL; enumerate the five boundaries explicitly in the drill plan.
- **Priority:** P2 (execution belongs to CR-5; name it now)

### 6. Outbox claim collision (two dispatchers claim simultaneously)

- **Current coverage:** ⚠️ `SKIP LOCKED` (DS:L114) is the correct mechanism; no concurrent-claim test exists (same PGlite limitation as case 3).
- **Sub-case — token collision:** `claim_token` has no UNIQUE constraint (SQL:L269) and `markOutboxDelivered`/`markOutboxFailed` authenticate purely on `(id, status='processing', claim_token)`. Two dispatchers sharing a token can acknowledge each other's rows. The design assumes per-claim unique tokens as caller discipline; nothing states or tests it.
- **Missing tests:** concurrent `claimOutbox` ⇒ disjoint row sets on real PG; a documented invariant "claim tokens are claim-scoped UUIDs, never shared" plus a lint/doc note.
- **Priority:** P2

### 7. Stale claim token (ack/fail with wrong or expired token)

- **Current coverage:** ✅ T:L205 — wrong token on deliver rejects (`/stale or missing/`); T:L213–214 — double `markOutboxDelivered` is an accepted no-op (second sees `status='delivered'`, DS:L135–136).
- **Expected invariant:** only the current token holder mutates a claim; post-terminal acks are idempotent.
- **Missing test:** symmetric stale-token case for `markOutboxFailed` (only the delivered side is exercised post-claim).
- **Priority:** P3

### 8. Retry delay (`available_at` honored)

- **Current coverage:** ✅ T:L206–209 — after fail with `availableAt=t5`, claim at `t1` returns 0 rows and at `t5` returns the row with `attempts=2`.
- **Expected invariant:** failed messages are invisible until their next availability time.
- **Note:** backoff policy is wholly caller-computed (schema stores only the resulting timestamp) — reasonable; record the contract "scheduler owns delay computation" in `docs/MIGRATIONS.md`.
- **Priority:** P3 (doc only)

### 9. Maximum-attempt policy (dead letter)

- **Current coverage:** ✅ claim filter `attempts < maxAttempts` (DS:L113) plus `CASE … 'dead_letter'` on fail (DS:L141); T:L216–224 drives a row to `dead_letter`.
- **Expected invariant:** terminal after N attempts; `dead_letter` never auto-reclaimed (CR-4B doc promise) — claim filter and `recoverStaleOutbox` (which only touches `status='processing'`) both honor it.
- **Missing tests:** explicit asserts that `dead_letter` rows are excluded from both claim and recovery paths (currently implied, not stated); document behavior when `maxAttempts` is lowered between retries (in-flight rows can jump straight to dead letter).
- **Priority:** P3

### 10. Abandoned processing claim recovery

- **Current coverage:** ✅ T:L210–212 — `recoverStaleOutbox({claimedBefore: t10})` requeues the stranded claim and the next claim observes `attempts=3`.
- **Expected invariant:** `processing` rows older than the cutoff return to the retryable pool with a fresh `available_at`.
- **Missing test:** the recovery-vs-late-ack race — original claimant calls `markOutboxDelivered` after `recoverStaleOutbox` flipped the row: token is NULLed so the update misses, the fallback sees `status='failed'` and throws (DS:L134–136). That throw is correct (ack genuinely lost ⇒ redelivery follows), but it is untested; a test pins the intended convergence.
- **Priority:** P2

### 11. Delivery acknowledgement loss (end-to-end at-least-once) — **second-largest gap**

- **Current coverage:** ⚠️ every component exists (claims increment attempts, recovery requeues, redelivery re-executes) but no test walks the full loop: effect performed at destination → ack lost → claim abandoned → recovered → **redelivered** → destination idempotency absorbs the duplicate. CR-3 §Data acceptance tests promises "outbox resumes without duplicate consequential delivery," and CR-4B doc stakes the whole delivery story on destination idempotency — yet the second delivery leg and the absorption contract appear in no test.
- **Missing test:** simulated destination (stub sink keyed by outbox idempotency_key) asserting exactly-once side effects across an injected ack loss; companion note in `docs/MIGRATIONS.md`: consumers MUST dedup on `(tenant_id, topic, idempotency_key)`.
- **Priority:** **P1**

### 12. Idempotency result replay

- **Current coverage:** ✅ T:L188–191 — same key + same digest returns the stored result; callback ran once (`effects === 1`).
- **Expected invariant:** `(tenant, scope, key)` + matching request digest ⇒ replay stored `result`, never re-execute.
- **Missing test:** cosmetic round-trip asymmetry — an operation returning `undefined` stores SQL NULL and replays as `null`; assert-and-accept or normalize to avoid surprising strict-equality consumers.
- **Priority:** P3

### 13. Idempotency key collision

- **Current coverage:** ✅ T:L192 — same key with a different `requestDigest` fails closed (DS:L90).
- **Expected invariant:** key reuse across differing requests is an error, never a silent overwrite.
- **Missing tests:** (a) same key under a different `operationScope` executes independently — intentional per the composite PK (SQL:L286) but unstated; (b) two concurrent `executeIdempotent` calls with the same key serialize on the unique index: loser waits for winner's commit and replays (never double-runs). Untestable on single-connection PGlite; belongs to the CR-5 concurrency suite.
- **Priority:** P2 (concurrency leg)

### 14. Restart behavior (application/database restart mid-flow)

- **Current coverage:** ⚠️ soft-restart proof exists (new store objects, same database: T:L102, T:L183). CR-3's "approval wait survives application and database restart" acceptance item is only indirectly exercised (lease renewal/expiry replay, T:L133–153).
- **Missing test:** a scripted restart suite stepping close/reopen between phases: inbox `received → processed` across restart; outbox `pending → processing(claimed) → delivered` across restart; idempotency record created in one session, completed in another.
- **Priority:** P2

### 15. Retention

- **Current coverage:** ❌ nothing prunes `control_inbox.processed`, `control_outbox.delivered`, or `control_idempotency.completed`; there are no TTL columns and no documented policy. Growth is compounded: every canonical mutation writes both a transition event and an outbox row (CS:L445–459). The one bounded thing is correct — `dead_letter` is exempt from automatic reclamation.
- **Expected invariant:** bounded delivery-table footprint consistent with CR-3's storage economics and "bounded evidence" posture; tombstoned idempotency keys retained longer than payloads.
- **Missing tests/design:** retention rule (e.g., delete `delivered` after N days in batches; keep idempotency keys as tombstones for M days), implemented as a migration + batched-delete function + test. Overlaps the sibling review's L-3 — cross-referenced deliberately, as both reviews independently hit it.
- **Priority:** P2 (before production deployment; not blocking CR-4C development)

---

## Structural observations (outside the 15 cases, recorded for completeness)

1. **Defensively unreachable states:** inbox `status='processing'` (DS:L54 throw) and `control_idempotency.status='processing'` on the read path (DS:L91) can only be reached by manual writes, because both flows commit their intermediate status inside the same transaction that completes it. Harmless today; if handlers ever move to cross-transaction execution these become load-bearing. Document the intent.
2. **No delivery-ordering guarantee:** `claimOutbox` orders by `available_at, created_at` globally; two rows for the same aggregate claimed by different dispatchers can arrive at the destination out of order. Outbox payloads carry entity versions (CS:L453–459), so consumers can reorder — state that as a consumer requirement alongside the case-11 dedup rule.

## CR-4B vs intentionally deferred

| Item | Disposition |
|---|---|
| Cases 1, 2, 4-rollback-half, 7, 8, 9, 10-mechanism, 12, 13-digest-leg | **CR-4B proper** — store-level, closable in this block |
| Case 4 poison-parking design, 11 end-to-end loop | **CR-4B scope, P1** — needs a small design decision + tests, no schema change required (inbox `failed`/`safe_failure_code` already exist) |
| True-concurrency proofs (3, 6, 13-concurrent-leg), kill-boundary drills (5) | **CR-5 rehearsal** on production-shaped PostgreSQL — single-connection PGlite structurally cannot prove them |
| Envelope `expiresAt` and signature enforcement, approval binding to effects | **CR-4C** authorization boundary (CR-4B doc §Remaining phase gates); note `expiresAt` currently crosses `receive` unenforced |
| Audit hash chain over transition events/outbox; `safe_failure_code` vocabulary standard | **CR-4D** |
| Retention job scheduling/operations (case 15 execution half) | **Pre-production ops**, design doc can land in CR-4B/4C |
| Per-connection monotonic sequences, node reconnect reconciliation | **Node protocol slice** (CR-5); inbox dedup by message ID already satisfies the durable-ID half of CR-3 §Delivery semantics |
| Replay/disconnect/restart tests for adapters | **Adapter conformance kit** (CR-3 §Adapter conformance kit) — distinct from store tests |

## Summary

Of the 15 required cases: **6 fully covered by tests**, **5 partially covered** (mechanism present, proof incomplete), **4 effectively uncovered** (handler rollback/poison inbox, ack-loss end-to-end loop, retention, true concurrency). Both P1 items need only repository-layer decisions and tests — the schema already provides the required fields. The matrix gives Codex/Sol a concrete review surface: confirm the four dispositions in the deferred table match the block plan, then treat the two P1 rows as CR-4B exit criteria.

## Reviewer disposition

Codex/Sol semantic review required before merge, per work packet. Suggested follow-through: fold P1 rows into CR-4B exit criteria, P2 rows into the CR-5 rehearsal checklist.
