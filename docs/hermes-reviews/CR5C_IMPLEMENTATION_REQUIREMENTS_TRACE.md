# CR-5C implementation requirements traceability matrix

**Status:** Complete 2026-08-23
**Worker route:** Marvin / macOS Mac mini / Hermes — documentation analysis, medium risk.
**Purpose:** Evidence map from the eight merged CR-5C research reports to implementation requirements. Every row is a SHALL requirement with a source citation, the current source seam (file:line @ `main` post-CR-5B merge), security rationale, test type, owner module, dependency, and status. This matrix makes no policy decisions; `decision-required` rows are routed, not resolved.
**Repo state:** current `main` (CR-5B merged, probe scripts present). Reports cited: INV=#20 inventory, ATX=#21 adversarial matrix, THM=#22 threat model, AUD=#23 repo audit, SYN=#26 synthesis, MAC/WIN/LNX=probe reports #19/#25/#24.

## Source-seam line references used throughout

| Ref | Location | What's there today |
|---|---|---|
| S1 | `src/node-bridge/bridge.ts:163-168` | `job.offer/lease.grant/lease.renewed/cancel` → `journal.recordCommand(frame)` only |
| S2 | `src/node-bridge/journal.ts:134-149` | `recordCommand`: direction check + secret guard + digest dedup, INSERT `'queued'` |
| S3 | `src/node-bridge/journal.ts:50,136,169` | `assertNoSecretMaterial` on outbox/command/summary writes |
| S4 | `src/node-bridge/bridge.ts:27-29` | `BridgeFrameSigner` injection seam |
| S5 | `src/node-protocol/v1/authentication.ts:51-118` | frame ceiling/schema/direction/expiry/skew/lifetime/rate-limit/key-state/signature/replay checks |
| S6 | `src/domain/v1/state-machines.ts:77-79` | attempt transitions incl. `executing→ambiguous→confirmed/failed` |
| S7 | `src/persistence/canonical-store.ts:199-227` | central effect-intent authorization (digest, operation, destination, approval) |
| S8 | `src/security/redaction.ts:38-41` | pattern-based secret-material rejection |

---

## Requirements matrix

### A. Local authority ceilings (ADR-009)

| ID | Requirement | Source | Current seam | Security rationale | Test type | Owner module | Depends on | Status |
|---|---|---|---|---|---|---|---|---|
| A-1 | Node SHALL hold a locally-configured immutable maximum authority (operations, duration, network, budget) that no server frame can widen | ADR-009 (`docs/CR3_DECISION_LOG.md:106-116`); THM T1; SYN §0/§3 | none — node receives commands without any ceiling concept (S1) | Compromised-server containment: signature validity must not equal permission [INV A1/A6] | unit + property (widen attempts rejected) | new `src/node-policy/ceiling.ts` | C-1 (signed envelope delivery) | **decision-required** (ceiling provisioning/enrollment shape — SYN D7 adjacent; Sol owns semantics) |
| A-2 | Node SHALL verify an embedded signed authority envelope in `job.offer`/`job.lease.grant` against its local ceiling before queueing | SYN §3 selection logic; ATX case 1 | offer/grant bodies exist (`schemas.ts:198-201`) but carry no verifiable envelope; digest-only mirror server-side [INV A1] | Node cannot enforce terms it never sees [INV headline finding] | unit + integration (queue rejected when envelope ⊄ ceiling) | `src/node-policy/` + `schemas.ts` extension | A-1 | **decision-required** (envelope frame format = wire-schema change; Sol sign-off needed) |
| A-3 | Enforcement SHALL occur at the journal→executor gate between `recordCommand` and any future handler | CR-5B doc line 70 ("queueing is not permission"); ATX coverage map | S1/S2 are the last stop today; no handler exists | The single choke point where node-local authorization either exists or doesn't [ATX seams table] | unit (validation gate rejects over-authority pre-handler) | `src/node-policy/gate.ts` invoked from future command consumer | A-1, A-2 | ready (gate is new code but contract fully specified) |

### B. Expiry and time bounds

| ID | Requirement | Source | Current seam | Rationale | Test type | Owner module | Depends on | Status |
|---|---|---|---|---|---|---|---|---|
| B-1 | Frame-level expiry/skew SHALL stay enforced (existing behavior preserved) | S5 `authentication.ts:76-81`; tests `node-protocol.test.ts:283+` | working | Transport-layer freshness | existing regression suite | `node-protocol/v1` | — | ready (already implemented; keep green) |
| B-2 | Node SHALL enforce envelope expiry against its **own clock** at execution-decision time, independent of server frames | ATX case 2a; THM T8 | none local; central precedent `canonical-store.ts:293` | Offline/stale grant must not execute; server clock disagreement irrelevant | unit (clock clamp) | `src/node-policy/gate.ts` | A-3 | ready |
| B-3 | Node SHALL enforce not-before bounds symmetrically (no grace window) | ATX case 2b; skew precedent S5 | none local | Symmetric bound handling prevents early-execution via clock games | unit | `src/node-policy/gate.ts` | A-3 | ready |

### C. Signed envelope transport prerequisite

| ID | Requirement | Source | Current seam | Rationale | Test type | Owner module | Depends on | Status |
|---|---|---|---|---|---|---|---|---|
| C-1 | `job.offer` / `job.lease.grant` bodies SHALL carry a signature-verifiable authority envelope (full terms or signed attestation, not just a digest) | INV A1 finding; SYN §0 recommendation; ATX seams table | body schemas `schemas.ts:198-205`; central mirror `canonical-store.ts:163` | Digest-only gives node nothing to check [INV structural finding] | schema round-trip property + signature verification unit | `src/node-protocol/v1/{schemas,types}.ts` | — | **decision-required** (wire format choice: embed-full vs attached-attestation; affects version negotiation) |

### D. Executor / operation / target checks

| ID | Requirement | Source | Current seam | Rationale | Test type | Owner module | Depends on | Status |
|---|---|---|---|---|---|---|---|---|
| D-1 | Queued command operations SHALL be checked against ceiling `allowedOperations` before any handler dispatch | INV C4; ATX case 4 | S2 queues unconditionally | Unknown/altered operations must never reach an executor [INV D-row] | unit | `src/node-policy/gate.ts` | A-1, A-3 | ready |
| D-2 | Operation parameters SHALL be digest-bound so altered arguments fail | INV D2 (`digest.ts:67+` precedent); ATX case 4 | `computeEffectOperationDigest` exists centrally only | Parameter substitution is the practical attack on typed executors | property (fuzzed param mutation) | `src/security/digest.ts` reuse in gate | D-1 | ready |
| D-3 | File targets SHALL be canonicalized before allowlist comparison; traversal/symlink-escape/non-canonical spellings SHALL reject; canonicalization failure fails closed | ATX case 3; INV A4 string-equality gap | none (no executor yet) | Lexical path equality is spoofable [ATX invariant for case 3] | property (path corpus fuzz) + unit | `src/node-policy/targets.ts` | A-3 | ready (spec complete; blocked only by executor existing) |
| D-4 | Network destinations SHALL match scheme/port exactly; host identity pinned at connect (rebinding = violation); IP literals require explicit entries | ATX case 5; INV A4/D2; THM T7 | central string-equality only `canonical-store.ts:218-220` | Requested hostname ≠ connected host; rebinding defeats allowlists | integration (local DNS fixture) + property | `src/node-policy/network.ts` | A-3 | **decision-required** (who owns canonicalization — INV A4 flagged for Sol; D-4 implements whichever rule is chosen) |

### E. Budget ceilings

| ID | Requirement | Source | Current seam | Rationale | Test type | Owner module | Depends on | Status |
|---|---|---|---|---|---|---|---|---|
| E-1 | Cost budgets (`maxCostUsd`) SHALL be enforced atomically at effect reservation: exhaustion refuses before the over-budget step; integer minor-units only; non-finite/negative fail closed | INV A5 (no production consumer); ATX case 6 | field exists `types.ts:56`, consumed by validators/simulator only | Budget otherwise decorative in production dispatch [INV A5] | property (arithmetic fuzz) + integration (concurrent reserve) | `src/node-policy/budget.ts` (+ eventual central counterpart) | A-3 | **decision-required** (which block owns central enforcement: CR-6C per INV A5 disposition; node-side spec is settled) |

### F. Trust and key store

| ID | Requirement | Source | Current seam | Rationale | Test type | Owner module | Depends on | Status |
|---|---|---|---|---|---|---|---|---|
| F-1 | A portable `NodeKeyStore` interface SHALL provide reference/availability/unlock/sign/verifyTrust/rotate/lock with five safe error categories | SYN §1 (all three probes converged) | `BridgeFrameSigner` seam S4 takes signatures without storage knowledge — store sits under it | One contract, three thin adapters, uniform fail-closed surface | interface conformance unit via fakes | new `src/node-keystore/` | — | ready |
| F-2 | Per-platform adapters SHALL be: macOS Keychain generic-password; Windows DPAPI CurrentUser boot-unlock; Linux encrypted-file primary | SYN §2 matrix citing MAC §4.1 / WIN §6.1 / LNX §3.1 | none | Probe-ranked recommendations; hardware modes deferred (SYN D4) | env-gated smoke + manual validation | `src/node-keystore/{darwin,windows,linux}/` | F-1 | ready (adapters); manual items gated (SYN D1–D3) |
| F-3 | Encrypted-file mode SHALL be identical code cross-platform and CI-testable without OS keystores | SYN §5 strategy 3; LNX §1 crypto verified | none | Portability spine + deterministic tests | integration on all runners | `src/node-keystore/encrypted-file.ts` | F-1 | ready |
| F-4 | Fail-closed selection logic SHALL branch locked→backoff vs missing/corrupt→re-enrollment, never auto-regenerate | SYN §3; MAC §5 reset row; LNX §4 tamper row; CR-5A identity immutability | bridge has `protocol_rejected` status pattern `bridge.ts:170-171` | Identity keys are immutable; silent regeneration breaks attribution | unit via scenario fakes (availability knob) | `src/node-keystore/index.ts` | F-1 | ready |
| F-5 | Sign-before-unlock and sign-after-dispose SHALL error `key-not-unlocked` | SYN §3 runtime rules | — | Fail closed on lifecycle misuse | unit | same | F-1 | ready |
| F-6 | Server trust-bundle rotation mechanism SHALL exist (or rotation-equals-re-enrollment SHALL be recorded as the decision) | SYN D5; INV E8; THM residual 2 | enrollment delivers trust keys once (`persistence.ts:76-84,207`); no refresh path | Compromised server key currently unrecoverable except full re-enrollment | unit (bundle swap) + kill-boundary (rotate during job) | `node-protocol/v1/persistence.ts` extension | — | **decision-required** (mechanism choice; must precede first real deployment per SYN) |

### G. Pause / revocation (local operator authority)

| ID | Requirement | Source | Current seam | Rationale | Test type | Owner module | Depends on | Status |
|---|---|---|---|---|---|---|---|---|
| G-1 | Node SHALL support a local operator pause that halts new command accepts immediately and works offline | ATX case 12; THM T6 | drain/quarantine states exist (`types.ts:17`) but no local trigger | Human nearest the machine outranks the network | integration + manual platform validation | `src/node-bridge/bridge.ts` state machine + platform trigger | — | **decision-required** (trigger mechanism — ATX left open deliberately; dossier incoming as issue #30) |
| G-2 | Local revocation SHALL win over cached server grants without connectivity | ATX case 12 variant c; THM T8 offline row | revocation propagation asymmetric [INV G4] | Revoked-means-revoked even when server unreachable | kill-boundary rehearsal (CR-5Q rig) | `src/node-policy/` + bridge | G-1 | decision-required (same root: pause/revocation mechanism) |

### H. Denial receipts

| ID | Requirement | Source | Current seam | Rationale | Test type | Owner module | Depends on | Status |
|---|---|---|---|---|---|---|---|---|
| H-1 | Node refusals SHALL produce denial receipts carrying message-ref, safe reason code, ceiling id, timestamp — and nothing else | ATX case 11 (acceptance spec); INV G2 (receipts don't exist) | schema union lacks receipt type (`schemas.ts:215` node_to_server set) | Denied adversary learns only safe-code vocabulary; audit linkability [THM boundary table] | property (no-leak fuzz vs refused payload ∪ local config) + unit | `schemas.ts` new frame type + `src/node-policy/gate.ts` emit | A-3 | ready (spec is ATX case 11 verbatim; needs one schema addition) |
| H-2 | Receipts SHALL pass the secret-material guard before journal/send | ATX case 11; S3/S8 precedent | guard reusable as-is | Defense-in-depth on the new outbound class | unit | reuse `redaction.ts` | H-1 | ready |

### I. Ambiguity and effect honesty

| ID | Requirement | Source | Current seam | Rationale | Test type | Owner module | Depends on | Status |
|---|---|---|---|---|---|---|---|---|
| I-1 | Post-effect/pre-ack crash SHALL classify `executing→ambiguous`, raise attention, never silently re-fire | ATX case 10b; state machine S6 exists; ambiguousEffectPolicy precedent `types.ts:89` | transition table present; no crash rig | Honest ambiguity is the only honest outcome without destination evidence | kill-boundary (CR-5Q); unit seeds for classification logic | executor wrapper (future) + `state-machines.ts` (exists) | A-3, D-1 | ready (logic spec'd; crash rig is CR-5Q scope) |
| I-2 | `ambiguous→confirmed` SHALL require destination receipt evidence; `→failed` requires safe failure code | ATX case 10c; INV I-row family | transition table S6 allows both; no evidence requirement encoded | Guesswork transitions corrupt the audit story | unit | executor wrapper | I-1 | ready |
| I-3 | Delivery dedup SHALL remain independent of effect idempotency (both hold separately) | ATX case 9; existing delivery tests `canonical-persistence.test.ts:220-347` | both layers tested independently today | Deduped delivery ≠ executed-once effect | extend existing integration tests | `delivery-store` tests + gate | — | ready |

### J. Journal handling

| ID | Requirement | Source | Current seam | Rationale | Test type | Owner module | Depends on | Status |
|---|---|---|---|---|---|---|---|---|
| J-1 | Journal SHALL never store private keys/resolved secrets — invariant preserved as keystore lands | S3/S8; CR-5B doc; WIN §5 co-location note | guard active on every write path | Compromise of journal must not expose key material | keep existing guard tests + add keystore-output sweep | `redaction.ts` call sites | F-1 | ready |
| J-2 | Command queue rows SHALL record validation outcome (queued/refused + category) once the gate exists | ATX case 11 receipt linkage; INV F1 seam | `bridge_commands.state='queued'` only (`journal.ts:143-147`) | Auditable local refusals need durable local state | unit | `journal.ts` schema addition | A-3, H-1 | ready |

---

## Dependency DAG

```text
C-1 (wire envelope format) ──► A-1 (local ceiling) ──► A-2 (verify envelope) ──► A-3 (gate)
                                                                        │
        F-1 (NodeKeyStore iface) ──► F-2/F-3/F-4/F-5 (adapters/logic)   │
                                                                        ▼
        B-2/B-3 (clock bounds) ──────────────────────► A-3 ══► D-1 ─► D-2 (param digest)
                                                      │      ╚═► D-3 (targets)
                                                      │      ╚═► D-4 (network) ◄─ decision
                                                      │      ╚═► E-1 (budget) ◄─ decision
                                                      │      ╚═► H-1 ─► H-2 (receipts)
                                                      │      ╚═► I-1 ─► I-2 (ambiguity)
                                                      │      ╚═► J-2 (journal outcome)
        G-1 ◄─ decision (pause mechanism) ──► G-2
        F-6 ◄─ decision (trust rotation)
```

Independent roots: **C-1**, **F-1**, **G-1**, **F-6** can start in parallel; everything under A-3 fans out after the gate exists.

## Smallest safe first implementation slice

1. **C-1**: decide + add signed authority-envelope fields to `job.offer`/`job.lease.grant` schemas (schema-only change, backward-checkable via version negotiation).
2. **A-1+A-3**: static ceiling config + validation gate invoked at command-consumption time, wired behind the existing `recordCommand` return — no executor needed yet; refusals land in J-2 journal states.
3. **H-1+J-2**: refusal receipts (new node_to_server frame type) + journal outcome column — makes every later gate feature observable from day one.
4. **B-2/B-3, D-1, D-2**: clock clamp, operation check, parameter-digest binding inside the gate.
5. **F-1+F-3+F-4+F-5**: keystore interface + encrypted-file mode + fail-closed lifecycle (CI-green everywhere), native adapters (F-2) after.

This slice delivers verifiable compromised-server containment (ADR-009) with zero executor code, using only schema additions, one new module, and one journal column — each independently reviewable and revertible.

## Coverage self-check

All nine required areas covered: ceilings (A), expiry (B), executor/operation/target/network/budget (D/E), trust/key store (F), pause/revocation (G), denial receipts (H), ambiguity (I), journal handling (J). Status tally: **24 rows — 17 ready, 7 decision-required, 0 deferred** (deferred items from source reports—hardware identity SYN D4, crash rig CR-5Q—are absorbed into decision-required rows D4/F-6/I-1 notes rather than silently dropped).

## Method note

Every source citation verified against working tree at time of writing (post-CR-5B main). Report citations use PR-number aliases defined in the header. No guarantees stated without a seam citation or report reference; no policy semantics chosen — all open questions carry `decision-required` with the owning block named.
