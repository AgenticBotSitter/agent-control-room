# CR-5C implementation work-slicing and safe delegation plan

**Work packet:** #50 (`[WORK][CR-5C] implementation work-slicing and safe delegation plan`)
**Worker route:** Ziggy / Windows PC (RIG1) / Hermes Agent desktop — model `stealth/ox-alpha` via Nous
**Task class:** Documentation-only; medium-risk planning. No code, tests, config, migrations, and **no chosen architecture**.
**Repo state:** `main` @ `049bf80`; synthesis ledger from PR #57 (`worker/ziggy/49-architecture-synthesis-ledger`); primary dossiers PRs #55/#51/#53/#56/#52/#54.

> **CONTINGENCY STATEMENT (acceptance requirement).** Every slice below is a *candidate* keyed to the recommended defaults in the architecture synthesis (PR #57, §5 ranked defaults) and the dossier decision IDs. **None of this is authorized work.** It becomes actionable only after Codex/Sol sets the final CR-5C contract (resolving at minimum D-44-A/C/D, D-47-A..F, CEIL mechanism, ROT v1 shape, ADM approach, DEST C3/digest question). Until then this file is planning input only.

**Citation aliases:** [LED] = `CR5C_ARCHITECTURE_SYNTHESIS_DECISION_LEDGER.md` (PR #57) · [STM] = #44 · [RCPT] = #47 · [ROT] = #45 · [ADM] = #46 · [CEIL] = #43 · [DEST] = #48 · [TRACE] = requirements trace · [5B] = CR-5B doc. Source pins @ `049bf80`.

---

## 0. Delegation safety model

Three worker classes, per packet requirement to separate architect-only code from safe external work:

| Class | Who | What | Examples |
|---|---|---|---|
| **A — Architect-only** | Codex/Sol | Trust anchors, schema/wire changes, anything where a mistake is a security-boundary hole | envelope format (TRACE C-1), bundle frame type, ceiling signature semantics |
| **B — Guided implementation** | Workers w/ Codex-reviewed contract already merged | Code whose correctness is checkable against a frozen spec + test vectors | gate checks, claim rows, validators |
| **C — Safe external-worker work** | Any worker, low blast radius | Fixtures, test cases, property oracles, platform adapters, UI, docs, rehearsal scripts | DNS lying fixture, clock fixtures, DPAPI adapter, drill docs |

Rule: a slice may move B→C only after its acceptance tests exist and pass on the reference implementation. Nothing moves into class A.

## 1. Slices

Ordering follows TRACE's dependency DAG + LED §5 ranking (high-confidence first). "Files" = allowed-path proposals for Codex to confirm; nothing here grants path access by itself.

### Slice 0 — Contract freeze prerequisites *(architect)*
- **Content:** resolve LED open decisions: D-44-A/C/D, D-47-A/B/C/E/F, CEIL mechanism + provisioning-key-vs-pause-key, ROT transport/interval/valid_until/shrink-signer, ADM J+D + refuse-vs-defer, DEST C3-digest + D-4b owner + private-range syntax.
- **Output:** ADR(s), frozen schemas. No slice below starts without it.
- **Reviewer effort:** high (this is the whole point of CR-5C).

### Slice 1 — Wire envelope + ceiling artifact formats *(class A)*
- **Allowed files:** `src/node-protocol/v1/schemas.ts`, `src/domain/v1/types.ts`, new `src/domain/v1/ceiling.ts`
- **Content:** signed authority envelope on offer/grant bodies [TRACE C-1/A-2]; ceiling artifact per CEIL §3 field set; trust-bundle envelope {epoch, keys[], minEpoch, valid_until?} [ROT §4]; approval attestation E2 shape [RCPT §7].
- **Dependencies:** none (DAG root).
- **Unit tests:** round-trip; bad-signature refuse; unknown-field strictness (v1 closed-schema discipline).
- **Prohibited:** any consumer wiring; no behavior change.
- **Merge order:** 1st. **Effort:** M. **Model rec:** strongest available (architect-adjacent).

### Slice 2 — Local ceiling store + integrity *(class B)*
- **Allowed files:** new `src/node-policy/ceiling-store.ts`, `src/security/digest.ts` (read-only reuse)
- **Content:** load/verify/high-water per CEIL §2; safe errors `ceiling_*`.
- **Depends:** Slice 1. **Tests:** CEIL §6.1–6.2 tamper/replay units + secret-guard fuzz.
- **Prohibited:** keystore writes beyond the MAC anchor; no rotation logic yet.
- **Merge order:** 2nd. **Effort:** M. **Rec:** mid-tier model fine; spec is frozen by then.

### Slice 3 — Authorization gate *(class B, highest-value)*
- **Allowed files:** new `src/node-policy/gate.ts`, `src/node-policy/policy-eval.ts`, journal outcome column [TRACE J-2]
- **Content:** B-2a clamp, operation/target checks, refusal receipts (coarse tier), journal states queued/refused+category.
- **Depends:** Slices 1–2. **Tests:** STM P-1/P-2, ATX case 1/4 units, J-2 unit.
- **Prohibited:** network checks (Slice 5); executor dispatch; effect claims (Slice 6).
- **Merge order:** 3rd. **Effort:** L. **Rec:** strong model; pure-function core must stay pure.

### Slice 4 — Clock monitor + expiry machine *(class B)*
- **Allowed files:** new `src/node-policy/expiry.ts`, executor wrapper seam
- **Content:** B-2b monitor emitting events; EXPIRING_SOON/EXPIRED transitions; grace G0 only if D-44-D says so; forbid EXPIRED→EXECUTING [LED challenge].
- **Depends:** Slice 3. **Tests:** STM U-1/U-2/U-4, P-3 min-deadline, K-1 seeds.
- **Prohibited:** live timers in unit scope (fake timer injection only); no renewal protocol changes.
- **Merge order:** 4th. **Effort:** M-L. **Rec:** strong model (concurrency edges).

### Slice 5 — Network guard *(class B)*
- **Allowed files:** new `src/node-policy/network.ts`
- **Content:** C3 tuple parse + allowlist subset; resolve-once pin + TLS name verify [DEST §4–5]; private-range deny with exception syntax; non-TLS tool exclusion rule [LED challenge].
- **Depends:** Slice 3; DEST C3-in-digest answer (freeze-blocker).
- **Tests:** DEST §8 symbolic corpus; redirect-hop unit; localhost-exception fixture if range-deny ships.
- **Prohibited:** no real network I/O in CI; integration DNS/TLS fixture stays env-gated/manual.
- **Merge order:** 5th. **Effort:** L. **Rec:** strong model.

### Slice 6 — Effect claims + ambiguity *(class B)*
- **Allowed files:** `src/node-bridge/journal.ts` (schema add), new `src/node-policy/effects.ts`
- **Content:** `effect_claims` table; admission key **per LED challenge** = `(nodeId, jobId, attemptId, operationDigest)` unless Codex accepts message-scoped hole; pre-effect proof row unified with STM's; restart classification mechanical; ambiguous receipts.
- **Depends:** Slice 3 (+4 for expiry interplay).
- **Tests:** ADM §5 set; kill-boundary seeds K-1/K-2; collision-stable key property.
- **Prohibited:** exactly-once language anywhere; automatic retry from AMBIGUOUS.
- **Merge order:** 6th. **Effort:** L. **Rec:** strong model.

### Slice 7 — Receipt privacy mechanics *(class B)*
- **Allowed files:** `src/security/redaction.ts` consumers, receipt builder module
- **Content:** V2 two-tier emit; digest-normative (+truncation iff D-47-C); coalescing/probe-budget (**default OFF at first deploy** [LED]); E2 verification helper.
- **Depends:** Slices 3/6 (emitters exist).
- **Tests:** RCPT P-1..P-8.
- **Prohibited:** V3 wire enum change; free text anywhere outbound.
- **Merge order:** 7th. **Effort:** M. **Rec:** mid-tier.

### Slice 8 — Trust-bundle client *(class B)*
- **Allowed files:** `src/node-protocol/v1/persistence.ts` extension, new bundle fetcher
- **Content:** epoch monotonic apply, ≥1-key floor, shrink countersign, journaled epoch record; out-of-band enrollment pin hook [LED challenge].
- **Depends:** Slice 1 format; frame-transport decision (ROT Q1).
- **Tests:** ROT §4.9 set incl. crash-between-fetch-and-apply; clock-manipulation fixtures (R4).
- **Prohibited:** no auto-re-enrollment; no keystore writes.
- **Merge order:** 8th. **Effort:** M-L. **Rec:** strong model.

### Slice 9 — Class-C parallel batch (safe external work, can start *now* as fixtures/docs)
- **9a Fixtures:** URL/path fuzz corpora [DEST §8]; clock fake library [STM]; epoch/bundle symbolic fixtures [ROT]; approval-attestation synthetic signer.
  - Files: `tests/fixtures/**`, `scripts/probes/**`. Effort S each.
- **9b Property-test skeletons:** P-1..P-8 stubs with oracle interfaces, no impl coupling.
- **9c Platform adapters (post-contract):** Keychain/DPAPI/encrypted-file `NodeKeyStore` implementations per SYN §1 six-method interface (verifyTrust dropped).
- **9d Docs/UI:** operator runbooks (pause drill, re-enrollment, ceiling rotation), local status display of availability states [OPS §2.8].
- **9e Rehearsal scripts:** CR-5Q kill-boundary drills from acceptance plan #34.
- All are delegable to any worker/model; review = diff vs frozen spec + fixture-oracle conformance.

## 2. Merge order & reviewer effort summary

| Order | Slice | Class | Effort | Reviewer effort | Model rec |
|---|---|---|---|---|---|
| 1 | S1 wire formats | A | M | High — schema review, adversarial read | strongest |
| 2 | S2 ceiling store | B | M | Med | mid |
| 3 | S3 gate | B | L | High — security-critical chokepoint | strong |
| 4 | S4 expiry | B | M-L | Med-High (timer/concurrency) | strong |
| 5 | S5 network | B | L | High | strong |
| 6 | S6 claims | B | L | High (crash windows) | strong |
| 7 | S7 receipts | B | M | Med | mid |
| 8 | S8 trust client | B | M-L | Med-High | strong |
| — | S9a–e | C | S-M each | Low-Med (spec conformance) | any |

Parallelism: S2+S9a/b can run beside S1's review; S4/S5/S6 fan out after S3 merges; S9c/e after their contracts freeze. One worker per slice (fleet one-packet rule).

## 3. No-parallel-conflict map

File-level exclusivity so two workers never touch the same path:

| Path | Slice(s) | Conflict rule |
|---|---|---|
| `schemas.ts`, `domain/v1/types.ts` | S1 only | exclusive while open; later slices consume, never edit |
| `ceiling.ts`, `ceiling-store.ts` | S1 / S2 sequential | S2 waits for S1 merge |
| `gate.ts`, `policy-eval.ts` | S3 | exclusive; S4/S5/S6 import it |
| `expiry.ts` | S4 | exclusive |
| `network.ts` | S5 | exclusive |
| `journal.ts` | S3 (outcome column) → S6 (claims table) | **serialize**: S6 rebases after S3 merge, never concurrent edits |
| `persistence.ts` | S8 only | exclusive |
| redaction/receipt builder | S7 | exclusive |
| `tests/fixtures/**`, probes | S9a | additive-only; no coordination needed |
| adapters | S9c | one platform per worker (mac/win/linux) — naturally disjoint |

Cross-slice shared-type risk lives entirely in S1: freeze types there and downstream conflicts disappear.

## 4. Prohibited changes (global, every slice)

No migrations outside declared schema adds; no protocol enum widening (v1 closed); no keystore API changes beyond SYN-as-corrected (six methods); no force-push to shared branches; no dependency additions without Codex sign-off; no test named or asserting "exactly-once"; no secret-shaped fixtures that resemble real credentials.

## 5. Acceptance self-checks

Contingent-on-final-contract stated up top ✔ · citations to synthesis (#57) + dossier decision IDs ✔ · slices carry files/deps/tests/prohibitions/order/effort/model recs ✔ · architect-only vs safe-external separation (§0) ✔ · no-parallel-conflict map ✔ · `git diff --check` clean at commit time ✔ · doc-only, single allowed path ✔

## Stop boundary

Planning only. Allowed path = this file. No code/tests/config/migrations; no architecture selected; nothing here authorizes implementation.
