# CR-5C authority-to-effect enforcement inventory

**Status:** Complete 2026-08-23
**Worker route:** Hermes / macOS Mac mini / provisional qualification — any-route documentation packet.
**Purpose:** Source-linked map of every existing authority, approval, job, effect, protocol, and bridge-delivery constraint from definition to use, with an explicit enforcement disposition (`central`, `node-local`, `deferred`, `ambiguous`) so Codex can implement CR-5C without rediscovering contracts. This report resolves no architecture decisions.
**Repo state analyzed:** `main` @ `489cd6d` (CR-5B complete).

## Reading guide

Every row cites exact file:line. "Enforcement" = where the constraint is actually checked today; "gap" = what CR-5C must add or decide. Line numbers refer to `489cd6d`.

## 1. Authority envelope and grant restrictions

| # | Concept | Canonical definition | Producer | Consumer | Current enforcement | Evidence | Missing node-local enforcement | Likely bypass / failure | CR-5C disposition |
|---|---|---|---|---|---|---|---|---|---|
| A1 | Authority envelope shape (project, executor, operations, network policy, effect policy, max duration/cost, expiry, parent digest) | `src/domain/v1/types.ts:47-60` (`AuthorityEnvelope`) | Workflow/job creation callers | `CanonicalStore.create` job branch; lease/renewal checks | Central: digest self-consistency + project binding at job create | `src/persistence/canonical-store.ts:192-197`; digest check `src/security/digest.ts:63-64` (`assertAuthorityDigest`); DB CHECK on mirrored digest `db/migrations/0004_cr4b_review_hardening.sql:31-32` | Node never sees the envelope — only its digest is mirrored to the `authority_digest` column (`src/persistence/canonical-store.ts:163`) | Compromised server sends a lease grant whose real envelope exceeds what was approved; node cannot tell | **implement**: ship full signed envelope in `job.offer`/`job.lease.grant` bodies so the node can verify against its local ceiling |
| A2 | Envelope expiry checked at claim and renewal | central | `claimReadyJob` `canonical-store.ts:293`; `renewLease` `canonical-store.ts:441-445` | — | Server-side clock trusted; node has no independent expiry check | **implement**: node-local wall-clock ceiling clamp |
| A3 | Lease duration ≤ `maxDurationSeconds` and ≤ authority expiry | central | `canonical-store.ts:294-297` (claim), `442-445` (renewal) | — | Same as A2 | **test only** once envelope reaches the node |
| A4 | Network allowlist for effect destinations | central | Effect-intent create `canonical-store.ts:218-220` | — | No DNS-resolution or IP-literal canonicalization anywhere; string equality only | Server-compromised allowlist entry `*.example.com` matched literally; rebinding unhandled | **decision required**: who canonicalizes destinations (server vs node) — flagged for Sol, do not resolve here |
| A5 | Cost ceiling (`maxCostUsd`) | defined `types.ts:56` | child-authority validator forbids cost expansion `src/domain/v1/authority.ts:25-26`; simulator budget policy `src/simulator/scheduler.ts:111` | Digest canonicalization `src/security/digest.ts:57` | **No production enforcement found** between job claim and effect execution — only child-envelope validation and the simulator consult it | Production claim/renewal/effect paths never read `maxCostUsd` | Cost budgeting is unenforced in real dispatch; enforced in simulation only | **ambiguous** → likely deferred to CR-6C budgets; must be stated explicitly in CR-5C docs |
| A6 | Role grants (actions, projects, risk ceiling, external-effect flag, strong factor) | `src/security/policy.ts:19-28` | DB rows via `SecurityStore.authorize` | `evaluatePolicy` `src/security/policy.ts:55-92`; re-validation at use `canonical-store.ts:620-671` (`requirePolicyDecision`) | Central only, by design (ADR-009) | Node trusts whatever the server dispatches | **out of scope** for node; CR-5C's local ceiling is the node-side complement |

## 2. Approval binding and consumption

| # | Concept | Canonical definition | Producer | Consumer | Current enforcement | Evidence | Gap | Bypass risk | Disposition |
|---|---|---|---|---|---|---|---|---|---|
| B1 | Approval record with operation-digest binding, risk, required actor type, expiry | `src/domain/v1/types.ts:158-170`; table `db/migrations/0003_canonical_domain_delivery.sql:130+`; digest-format CHECKs `0004:35-37`; one-live-approval-per-operation unique index `0004:49-51` | approval workflow (states `src/domain/v1/state-machines.ts:85-91`) | `authorizeEffect` | Central: approval must be `approved`, digest-equal, risk-equal, unexpired | `canonical-store.ts:554-564` | None central; consumption row written same-tx `565-570` | Solid centrally; absent node-locally | **implement** node-side verification that its copy of the approval evidence matches the effect digest |
| B2 | Single-use approval consumption | `control_approval_consumptions` append-only table `db/migrations/0005_cr4c_identity_policy.sql:60-92` | `authorizeEffect` | unique index `uq_control_effect_intents_approval` (`0004:52-53`) blocks a second effect per approval | Central, append-only trigger-guarded | `0005:86-92` | One approval → one effect enforced by UNIQUE(approval_id) — but note this caps effects-per-approval at 1 globally per tenant, which is a design choice, not a bug | Forged server could skip `authorizeEffect` entirely when dispatching to a naive node | **test only** centrally; **implement** node-local denial receipts for missing/stale approval evidence (see D-row family) |
| B3 | High-risk effects require strong-factor evidence + mandatory approval | `canonical-store.ts:550-552, 571-573`; policy gate `policy.ts:76-83` | central | central | Central | — | Node cannot independently verify strong factor happened | **deferred** to CR-8B approval domain per build plan; CR-5C should still fail closed locally when approval evidence is absent |

## 3. Job target/tool/network/cost/time constraints

| # | Concept | Definition | Enforcement point | Evidence | Gap | Disposition |
|---|---|---|---|---|---|---|
| C1 | Job→workflow→project lineage binding (incl. authority.projectId match) | `canonical-store.ts:188-197` | central | — | Node receives no lineage proof it can check | **implement**: include lineage digests in offer frames |
| C2 | Dependency satisfaction before `ready` | `canonical-store.ts:707-717` | central | — | — | **out of scope** (scheduler concern) |
| C3 | Executor restriction (`allowedExecutor`) | field exists `types.ts:49`; child-authority validator forbids executor change `src/domain/v1/authority.ts:18` | **No dispatch-time enforcement found** — no code compares a claim's worker/node to `allowedExecutor` at offer or claim time (grep over `src/persistence`, `src/node-*` shows zero reads) | A job can be claimed by any active node regardless of declared executor; only parent/child envelope consistency is checked | **decision required**: enforce centrally at offer time, node-locally at accept time, or both |
| C4 | Tool/operation constraint | `allowedOperations` checked at effect-intent creation `canonical-store.ts:215` | central | — | Node executes commands queued via bridge with no operation check | **implement**: CR-5C's core — validate every queued command against a local ceiling before execution (CR-5B explicitly defers this: `docs/CR5B_PORTABLE_NODE_BRIDGE.md:70`) |
| C5 | Time constraints | claim/renewal checks above | central | — | see A2/A3 | as A2 |

## 4. Effect intent, idempotency, ambiguous effects

| # | Concept | Definition | Enforcement | Evidence | Gap | Disposition |
|---|---|---|---|---|---|---|
| D1 | Effect intent requires active attempt + digest match + operation-in-authority + destination-in-allowlist + approval when required | `canonical-store.ts:199-227` | central | — | All checks are server-side; the executing node re-verifies nothing | **implement** (node-local mirror) |
| D2 | Operation digest binds project + operation + destination + idempotency key | `src/security/digest.ts:67+` (`computeEffectOperationDigest`); verified `canonical-store.ts:212-214` | central | — | Node cannot recompute without projectId + canonicalization code | **test only** if digest inputs ship in the frame; else **decision required** |
| D3 | Ambiguous-effect state machine (`executing → ambiguous → confirmed/failed/cancelled`) | `state-machines.ts:75-82`; attention partial index `0003:292` | central | — | Bridge journal has attempt states incl. crash boundaries but no effect-state concept (`journal.ts:278-287`) | **implement**: CR-5D synthetic executor + CR-5C denial/ambiguity receipt path |
| D4 | Delivery idempotency (inbox dedup, exact-retry-vs-replay-conflict) | protocol level `node-protocol/v1/persistence.ts:269-318` (server side), bridge side `node-bridge/journal.ts:190-219`; ack semantics `bridge.ts:134-176` | both ends, independently | — | Idempotency of *delivery* ≠ idempotency of *effect*; covered delivery-wise | **out of scope** beyond matrix tests (issue #15 covers) |

## 5. Protocol envelopes and server trust

| # | Concept | Enforcement | Evidence | Gap | Disposition |
|---|---|---|---|---|---|
| E1 | Frame size cap, strict schema, direction/type ownership | `authentication.ts:51-74` | central+node symmetric | — | **test only** |
| E2 | Expiry, skew, lifetime bounds | `authentication.ts:76-81` | symmetric | — | **test only** |
| E3 | Rate limiting cannot be bypassed by unverified fields | `authentication.ts:83-92`; guard contract `rate-limit.ts` | both | — | **test only** |
| E4 | Secret-material guard before persistence/auth | `redaction.ts:23-41`; called at `authentication.ts:93-98`, journal writes `journal.ts:50,136`, store writes `canonical-store.ts:182,674-675`, `security-store.ts:86` | both ends | Pattern-based; novel secret shapes pass | **test only** + periodic pattern review |
| E5 | Key state/principal-state rejection (quarantine/revocation) | `authentication.ts:100-106` | symmetric | Revoked-key non-restoration tested per CR-5A doc §Verification | **test only** |
| E6 | Ed25519 signature over canonical frame minus `signature` | `crypto.ts` (`verifyNodeFrameSignature`), used `authentication.ts:107-111` | symmetric | — | **test only** |
| E7 | Replay: durable message ID + nonce + monotonic per-connection sequence; exact retry = duplicate, altered reuse = conflict | server `persistence.ts:266-318`; node `journal.ts:190-219`; decision basis ADR-022 (`docs/CR3_DECISION_LOG.md:262-272`) | both | Replay tombstones bounded by expiry window; sequence continuity prevents old-sequence revival after prune (`docs/CR5A_NODE_PROTOCOL_AND_IDENTITY.md:66`) | **test only** |
| E8 | Server trust keys provisioned at enrollment (1–8 Ed25519 keys) | `NodeEnrollmentStore` ctor `persistence.ts:76-84`; delivered in challenge response `persistence.ts:207` | enrollment-time | **No rotation/revocation path for server trust keys exists yet** — resolver `DatabaseNodeKeyResolver` resolves *node* keys only (`persistence.ts:245-246` returns undefined for control_room sender) | **decision required**: server-trust rotation belongs to CR-5C key-store work or later block; currently a compromised server key can only be fixed by re-enrollment |

## 6. Bridge journal, retry, acknowledgement behavior

| # | Concept | Enforcement | Evidence | Gap | Disposition |
|---|---|---|---|---|---|
| F1 | Queueing-is-not-execution principle | documented `docs/CR5B_PORTABLE_NODE_BRIDGE.md:70`; structurally, `receive()` only records commands `bridge.ts:163-168` | node-local (vacuous today — nothing executes anything) | The executor that will consume `bridge_commands` does not exist yet | **implement** (CR-5C/D): the validation gate between `recordCommand` and any future handler is THE seam |
| F2 | Journal never stores private keys/resolved secrets | `assertNoSecretMaterial` on every write path `journal.ts:50,136,169` | node-local | Guard is pattern-based (E4 caveat) | **test only** |
| F3 | Backpressure ceilings, essential reserve, coalescing | `journal.ts:48-84` | node-local | — | **test only** |
| F4 | Crash-boundary durability (auth-receipt vs processed states; resend after reconnect) | `bridge.ts:132-176`; `flushPriorConnections` `243-256`; CR-5B doc §Local SQLite journal | node-local | Attempt lifecycle frames resend exactly; command frames have no post-crash execution guarantee yet (ties to F1) | **test only** for delivery; **implement** for execution semantics |
| F5 | Outbound message-ID/content binding | `stageOutbound` digest check `journal.ts:53-56` | node-local | — | **test only** |

## 7. Revocation, deny receipts, audit linkage

| # | Concept | Enforcement | Evidence | Gap | Disposition |
|---|---|---|---|---|---|
| G1 | Append-only audit events with hash chain | triggers `0002:80-82`; chain columns `0006_cr4d_audit_chain.sql:1-4` | central | Chain anchoring/verification cadence not yet wired (per CR-4D doc scope) | **out of scope** for CR-5C except: node denial receipts must be designed to be audit-linkable |
| G2 | Denial receipts | **Do not exist.** No deny-receipt type in schemas (`schemas.ts` union has `protocol.error` only), no local quarantine/quota feedback channel | grep confirms | A node that rejects an over-authority command has no safe, auditable way to tell Control Room why | **implement**: CR-5C must define the denial receipt shape (safe codes, no capability echo) and its delivery path |
| G3 | Policy-decision revocation re-check at use time | `requirePolicyDecision` verifies grants still active/expiry `canonical-store.ts:655-663` | central | Decisions live max ~5 min (`security-store.ts:129-133`) bounding staleness | **test only** |
| G4 | Identity/key revocation propagation to nodes | key/principal state checked server-side at auth `authentication.ts:100-102`; nodes learn of their own revocation only via connection failure/error frames | asymmetric | A revoked node keeps executing its current lease until lease expiry — acceptable per lease semantics, but not explicitly decided | **decision required**: does CR-5C add a push-revocation event, or rely on short leases? |

## 8. Five highest-value implementation seams (non-binding)

1. **Command-queue validation gate** (F1/C4): between `SqliteBridgeJournal.recordCommand` and any future executor — the single point where node-local ceilings either exist or don't. `src/node-bridge/journal.ts:134`.
2. **Signed authority envelope in job frames** (A1/A2): extend `job.offer`/`job.lease.grant` bodies so the node holds verifiable terms, not just a digest column. `src/persistence/canonical-store.ts:163`, `src/node-protocol/v1/schemas.ts` (offer/grant bodies).
3. **Denial receipt frame type** (G2): new node_to_server message with safe reason codes; closes the loop between local refusal and central audit. `src/node-protocol/v1/schemas.ts`.
4. **Server trust key rotation story** (E8): trust-bundle refresh mechanism or explicit "rotate = re-enroll" decision recorded before first real deployment. `src/node-protocol/v1/persistence.ts:76-84`.
5. **Destination canonicalization rule** (A4/D2): one owner (server or node) for network-allowlist matching semantics, decided before CR-5C tests harden string equality. `canonical-store.ts:218`.

## Method note

Derived solely from reading `main` @ `489cd6d`: all files under `src/security/`, `src/domain/v1/`, `src/persistence/`, `src/node-protocol/v1/`, `src/node-bridge/`, migrations `0001–0009`, and docs `CR3_BUILD_PLAN.md`, `CR3_DECISION_LOG.md`, `CR4C_SECURITY_CORE.md`, `CR5A_NODE_PROTOCOL_AND_IDENTITY.md`, `CR5B_PORTABLE_NODE_BRIDGE.md`. "No consumer found" claims were verified by grep across `src/`. No code was executed beyond static reading; no claims about runtime behavior are made beyond what cited lines implement.
