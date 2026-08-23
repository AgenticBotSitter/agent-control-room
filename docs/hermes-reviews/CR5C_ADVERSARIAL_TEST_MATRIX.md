# CR-5C adversarial policy and effect-enforcement test matrix

**Status:** Complete 2026-08-23
**Worker route:** Hermes / macOS Mac mini / provisional qualification — QA-design documentation packet.
**Purpose:** Translate CR-5C's containment intent (ADR-009, `docs/CR3_DECISION_LOG.md:106-116`) into compact adversarial cases a future implementation must pass. This is the test matrix, not the policy engine. Every input is symbolic; no authentic credentials, URLs, tenant IDs, or production data appear.
**Repo state analyzed:** `main` @ `489cd6d`. Each case maps to the current source seam it will exercise and states what is presently impossible to test.

## Notation

- **Decision** = expected CR-5C enforcement outcome at the node boundary.
- **Receipt/audit outcome** = what must be durably observable afterwards.
- **Invariant** = the exact property that must never break.
- **Seam** = where the case attaches in current code.
- **Class**: unit / property / integration / kill-boundary / manual-platform.

## Matrix

### 1. Server authority exceeds node ceiling

| Field | Value |
|---|---|
| Precondition | Node holds local ceiling C = {operations: [`op.a`], maxDuration: 600s, network: none}. Server sends validly signed `job.lease.grant` whose embedded authority allows {operations: [`op.a`, `op.b`], maxDuration: 7200s}. |
| Inputs (symbolic) | Signed frame with authority digest D₁ ≠ local ceiling digest C. |
| Expected decision | Reject execution regardless of signature validity. |
| Receipt/audit | Denial receipt (safe code `ceiling_exceeded`) journaled locally + delivered server-side; no executor invocation. |
| Invariant | A correctly signed frame can never widen node-local limits (ADR-009). |
| Seam | Command-validation gate between `SqliteBridgeJournal.recordCommand` (`src/node-bridge/journal.ts:134`) and future handler — currently absent by design (`docs/CR5B_PORTABLE_NODE_BRIDGE.md:70`). |
| Class | unit → later kill-boundary rehearsal. |

### 2a. Expiry on either side

Server-frame expiry already tested centrally (`tests/node-protocol.test.ts:283` family). CR-5C adds the **local clock vs envelope expiry** case:

| Field | Value |
|---|---|
| Precondition | Envelope expiresAt = T+600. Node wall clock reads T+601. |
| Expected decision | Refuse; do not consult the server for an extension inside the executor path. |
| Receipt | Denial receipt `authority_expired_local`. |
| Invariant | Expiry is enforced against the node's own clock even if the server's clock disagrees. |
| Seam | Local ceiling evaluator (new); lease expiry precedent `src/persistence/canonical-store.ts:293`. |
| Class | unit. |

### 2b. Not-before skew

| Field | Value |
|---|---|
| Precondition | Envelope validFrom = T+300 (future); node clock T. |
| Expected decision | Refuse until validFrom; no grace window. |
| Receipt | Denial receipt `authority_not_yet_valid`. |
| Invariant | Symmetric skew handling on both bounds (frame-level precedent: `src/node-protocol/v1/authentication.ts:79-81`). |
| Class | unit. |

### 3. Target mismatch and path traversal/canonicalization ambiguity

| Field | Value |
|---|---|
| Precondition | Ceiling allows scratch root `/srv/cr-scratch/<node-id>`. Queued command targets `/srv/cr-scratch/../other-node/secrets` or a symlink resolving outside the root, or a non-canonical spelling (`//srv/...`, trailing slash, URL-encoded). |
| Expected decision | Canonicalize first, then compare; reject traversal, symlink escape, and every non-canonical spelling. Fail closed when canonicalization itself fails. |
| Receipt | Denial receipt `target_outside_scope`. |
| Invariant | Authorization compares canonical paths only; lexical string equality of raw paths never authorizes (echoes inventory finding A4 on destination string-equality, `canonical-store.ts:218-220`). |
| Seam | Executor target validator (new); allowlist precedent above. |
| Class | property (fuzzed path corpus) + unit. |

### 4. Tool/operation mismatch

| Field | Value |
|---|---|
| Precondition | Ceiling allows operation `op.render`. Queued command requests `op.shell` or `op.render` with altered argument digest. |
| Expected decision | Reject unknown operations and digest-mismatched parameters before queue-to-handler handoff. |
| Receipt | Denial receipt `operation_not_authorized`. Central mirror: effect-intent create rejects operation outside authority (`canonical-store.ts:215`). |
| Invariant | Every executed operation equals an operation named in the verified authority, parameter-bound by digest. |
| Class | unit. |

### 5. Network host/port/scheme mismatch, DNS rebinding, IP-literal ambiguity

| Field | Value |
|---|---|
| Precondition | Allowlist entry symbolic host `api.example.test:443 https`. Adversarial variants: `http` scheme-downgrade; port 8443; DNS resolves first to allowed IP then to attacker IP mid-job (rebinding); same host given as raw IP literal; IPv6 bracket forms. |
| Expected decision | Scheme/port must match exactly. Host pinned at first resolution (connect-time re-verification) or rebinding treated as violation. IP literals rejected unless the allowlist entry is itself an IP with matching canonicalization. |
| Receipt | Denial receipt `network_destination_violation`; central allowlist check remains authoritative for effect intents (`canonical-store.ts:218-220`) but node re-checks independently. |
| Invariant | The socket the executor opens terminates at the host the ceiling named — resolved-and-connected identity, not merely requested hostname. |
| Seam | New network guard in executor; **decision required** row A4 of the enforcement inventory (who owns canonicalization). |
| Class | integration (local DNS fixture) + property. |

### 6. Cost/time/concurrency budget exhaustion and integer/rounding edges

| Field | Value |
|---|---|
| Precondition | Budget B units. Variants: spend exactly B−1 then request 2 more; cost reported as fractional float (`0.1+0.2`); `maxCostUsd = 0`; negative or NaN duration; concurrent sibling jobs sharing one budget; `Number.MAX_SAFE_INTEGER+1` seconds. |
| Expected decision | Exhaustion refuses *before* the over-budget step. Float costs rejected or quantized deterministically (integer minor-units only). Zero budget permits zero-cost operations only. Non-finite/negative values fail closed. Concurrency: atomic reserve-or-refuse, no double-spend across processes. |
| Receipt | Denial receipt `budget_exhausted` / `invalid_budget_parameter`. |
| Invariant | Total charged spend ≤ ceiling under any interleaving. Note current gap: `maxCostUsd` has no production consumer (inventory A5) — this case defines the tests that must accompany whichever block implements it. |
| Class | property (arithmetic fuzz) + integration (concurrent reserve). |

### 7. Child task/effect expansion beyond parent authority

Central child-envelope validation exists (`src/domain/v1/authority.ts:18,25-26` — executor change and cost expansion rejected). CR-5C adds the dispatch-boundary case:

| Field | Value |
|---|---|
| Precondition | Parent authority P dispatched to node. Server sends child grant C′ derived from P but adding network destination or extending duration beyond P's remaining window. |
| Expected decision | Node recomputes child-vs-parent subset relation locally; reject any dimension not ⊆ parent. |
| Receipt | Denial receipt `child_authority_expansion`, echoing safe codes used centrally (`cost_authority_added`, `executor_changed` etc.). |
| Invariant | Authority can only narrow along the delegation chain, at every boundary that can execute. |
| Class | property (subset relation over generated envelope pairs). |

### 8. Missing/revoked server trust

| Field | Value |
|---|---|
| Precondition variants: (a) trust bundle empty after failed rotation; (b) signing key present but marked revoked in bundle v2 while a v1-cached copy still verifies; (c) zero keys advertised at enrollment attempt (constructor forbids, `persistence.ts:77`). |
| Expected decision | All frames unverifiable → bridge enters backing_off, executes nothing from cache. Revocation must win over cached trust without requiring connectivity. |
| Receipt | Bridge status `protocol_rejected` (existing pattern `bridge.ts:128-129,170-171`); local journal entry; no command execution. |
| Invariant | Absence of verifiable trust fails closed; stale cached trust never outvotes explicit revocation. Known adjacent gap: no rotation mechanism exists yet (inventory E8). |
| Class | unit (bundle swap injection) → kill-boundary rehearsal (rotate during live job). |

### 9. Stale/duplicate/conflicting delivery vs effect idempotency

Delivery-layer primitives exist and are tested (exact-retry duplicate vs replay conflict: `journal.ts:190-219`, `persistence.ts:266-318`; ack-loss loop: `tests/canonical-persistence.test.ts:321-347`; poison parking: `:250-276`). CR-5C adds the **effect-boundary** cases:

| Field | Value |
|---|---|
| Case 9a | Same effect idempotency key, different requestDigest → second must refuse (`different request digest` precedent `delivery-store` tested `canonical-persistence.test.ts:245`). |
| Case 9b | Duplicate delivery arrives while original effect is mid-execution (not yet terminal) → second invocation must serialize/refuse, not run concurrently. |
| Case 9c | Effect completed node-locally but confirmation lost → reconciliation reports state; redelivery must resolve via idempotency result replay (`executeIdempotent` precedent), never re-fire. |
| Invariant | Delivery dedup ≠ effect idempotency; both must hold independently. |
| Class | integration. |

### 10. Crash boundaries around effects

Three windows, per CR-4Q precedent (`tests/canonical-persistence.test.ts:349-390` covers pre-effect):

| Field | Value |
|---|---|
| 10a Pre-effect crash | Intent recorded `proposed`, nothing fired → restart may re-authorize safely. Assert no executor side channel fired. |
| 10b Post-effect/pre-ack crash | Effect fired externally, intent still `executing` locally → restart must classify `ambiguous` (state machine `executing→ambiguous` exists, `state-machines.ts:77`), raise attention, never silently re-fire (ambiguousEffectPolicy `attention` precedent `types.ts:89`). |
| 10c Ambiguous completion | Destination confirms after ambiguity raised → transition `ambiguous→confirmed` only with destination receipt evidence; `ambiguous→failed` requires safe failure code, not guesswork. |
| Invariant | Exactly-once *observable* semantics built from at-least-once delivery + idempotent destinations + honest ambiguity. Kill-boundary rehearsals inject process death at each window (CR-5Q scope per build plan). |
| Class | kill-boundary (CR-5Q) with unit seeds now. |

### 11. Denial receipts leak no capability or secret data

| Field | Value |
|---|---|
| Precondition | Any denial in cases 1–8 fires. Receipt body passes through the secret guard (`assertNoSecretMaterial`, `redaction.ts:38-41`). |
| Expected decision | Receipt contains: message ref, safe reason code, ceiling identifier, timestamp. Contains none of: refused operation arguments, allowlist contents, key material, internal paths. |
| Property test | For every denial path, receipt ∩ (refused payload ∪ local config) = ∅ — fuzz receipts with secret-shaped payloads and assert rejection/redaction. |
| Invariant | A denied adversary learns only that it was denied and why in safe-code vocabulary. Note: denial receipts do not exist yet (inventory G2) — this case is their acceptance spec. |
| Class | property + unit. |

### 12. Local operator emergency pause/revocation

| Field | Value |
|---|---|
| Precondition | Owner triggers local pause (file sentinel / CLI signal — mechanism is a CR-5C decision) while a job is running. Variants: pause before lease accept; mid-execution; revocation while disconnected from server. |
| Expected decision | Pause halts new accepts immediately; mid-execution cancels via existing cancellation path or marks ambiguous per 10b; revocation works offline (no server round-trip). |
| Receipt | Transition event + audit linkage; node shows quarantined/draining state locally. |
| Invariant | The human physically nearest the machine always has a strictly stronger authority than the network. |
| Class | manual-platform validation + integration. |

## Presently impossible to test (and what would unblock each)

| Blocked case | Why | Unblocked by |
|---|---|---|
| True concurrency at the node (cases 6, 9b) | Single-connection PGlite in tests; single-process bridge topology | Real PostgreSQL rehearsal (CR-4Q plan) + multi-process bridge spec decision |
| Kill-boundary windows (case 10) as automated tests | Requires process-crash injection harness | CR-5Q crash/reconcile rig |
| Keychain/DPAPI/keyring-dependent cases (#11/#12/#13 probes' follow-ups) | No platform keystore implemented | CR-5C key-store interface + probe-recommended disposable-machine experiments |
| Network rebinding (case 5) end-to-end | Needs controllable DNS fixture and live socket policy | Integration environment with local resolver (build-plan CR-6A platform gates) |

## Coverage map to source seams

| Cases | Primary seam | Current state @ 489cd6d |
|---|---|---|
| 1, 4, 7 | command-validation gate (absent) | deferred by CR-5B (`bridge.ts:163-168` records only) |
| 2a, 2b, 6 | local ceiling evaluator (absent) | central precedents only |
| 3, 5 | executor target/network guard (absent) | central string-equality only |
| 8 | server-trust bundle handling | partial: enrollment delivers keys once (`persistence.ts:207`), no refresh |
| 9 | delivery stores + effect idempotency | delivery tested; effect-boundary cases new |
| 10 | state machines + journal attempts | states exist; crash rig does not |
| 11 | redaction + new receipt type | guard exists; receipt type absent |
| 12 | bridge lifecycle + operator tooling | drain/quarantine states exist (`types.ts:17`); no local trigger |
