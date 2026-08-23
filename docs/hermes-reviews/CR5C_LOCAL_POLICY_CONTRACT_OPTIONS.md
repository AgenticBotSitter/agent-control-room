# CR-5C proposed local-policy contract options and incompatibility analysis

**Work packet:** #28 (`[WORK][CR-5C] proposed local-policy contract options and incompatibility analysis`)
**Worker:** Ziggy (PC Hermes / Windows + RTX 3070 host)
**Harness/model:** Hermes Agent desktop, model route `stealth/ox-alpha` via Nous
**Date:** 2026-08-23
**Task class:** Documentation analysis; medium risk; doc-only. No code, no final selection.
**Purpose:** Present 2–3 explicit *candidate* TypeScript contract shapes for node-local policy evaluation so Codex can choose. Nothing here is an ADR.

## Source seams read (exact references)

| Seam | File | Relevant exports |
|---|---|---|
| Domain authority | `src/domain/v1/types.ts` L47–60 | `AuthorityEnvelope` (projectId, allowedExecutor, allowedOperations, credentialRefs, networkPolicy, allowedNetworkDestinations, effectPolicy, maxDurationSeconds, maxCostUsd?, expiresAt, parentDigest?, digest) |
| Delegation check | `src/domain/v1/authority.ts` | `compareDelegatedAuthority` / `assertDelegatedAuthority` — parentDigest binding, scope-narrowing-only rule |
| Server-side policy | `src/security/policy.ts` | `AuthenticatedPrincipal`, `RoleGrant`, `AuthorizationRequest`, `PolicyDecision` (allowed, reasonCodes[], matchedGrantIds[], requestDigest, strongFactorEvidenceId?) |
| Protocol frames | `src/node-protocol/v1/types.ts` L116–137 | `OfferDecisionBody.decision` ∈ {accepted, rejected} + `safeReasonCode?` ∈ {capacity, policy, version, storage, credential_unresolvable, maintenance, benchmark_expired}; `LeaseGrantBody.authorityDigest` |
| Bridge signer | `src/node-bridge/bridge.ts` L27–36 | `BridgeFrameSigner` (signs canonical frame bytes; no key-store knowledge), `BridgeIdentity` |
| Journal guard | `src/node-bridge/journal.ts` (+CR-5B doc) | secret-material guard before persistence; journal never stores private keys or resolved credentials |

Convention used below: **[E]** = field exists today at a cited seam; **[P]** = proposed new field.

---

## Option A — "Ceiling-first evaluation" (pure local derivation)

Local policy is a pure function of three locally-held immutable artifacts plus one request object. No new server round-trips.

```typescript
// [P] Immutable, enrolled-at-enrollment-time or provisioned-with-trust-bundle.
// Must be covered by the same integrity mechanism as the server-trust bundle
// (CR-5A §Authentication order step 7–8 analog for local material).
export interface NodeLocalCeiling {
  ceilingVersion: number;              // [P] monotonic; bump = re-provision, never edit in place
  tenantId: string;                    // [E] mirrors AuthenticatedPrincipal.tenantId binding
  nodeId: string;                      // [E] immutable per CR-5A enrollment
  maxRiskClass: "low" | "medium" | "high" | "critical"; // [P] mirrors RoleGrant.riskCeiling semantics
  allowedExecutors: string[];          // [E] narrows AuthorityEnvelope.allowedExecutor values
  allowedOperations: string[];         // [E] same vocabulary as AuthorityEnvelope.allowedOperations
  networkPolicy: "none" | "allowlist"; // [E] copied shape from AuthorityEnvelope; local value must be ⊆ ceiling intent
  effectPolicyMax: "none" | "preauthorized" | "approval_required"; // [E] rank like authority.ts effectRank
  allowExternalEffects: boolean;       // [E] mirrors RoleGrant.allowExternalEffects
  digest: string;                      // [P] canonical sha256 of the above (src/security/digest.ts)
}

// [E→P] The offer already carries AuthorityEnvelope by digest on the wire
// (LeaseGrantBody.authorityDigest); the node resolves it against the offer body.
export interface ReceivedAuthority {
  envelope: AuthorityEnvelope;         // [E]
  offerId: string;                     // [E] binds to JobOfferBody
  leaseId?: string;                    // [E] present only post-grant
  receivedAt: string;                  // [P] RFC3339
}

// [P] Normalized command/effect request produced by the command queue (CR-5B:
// queueing ≠ permission). This is the thing the local evaluator judges.
export interface LocalEffectRequest {
  requestId: string;                   // [P] idempotency at node level
  offeredJobId: string;                // [E]
  operation: string;                   // [P] must ∈ AuthorityEnvelope.allowedOperations vocabulary
  requestedExecutor: string;           // [P]
  requiresNetwork: boolean;            // [P]
  networkDestinations: string[];       // [P] checked only when envelope.networkPolicy === "allowlist"
  estimatedDurationSeconds?: number;   // [P] advisory vs envelope.maxDurationSeconds
  riskClass: RiskClass;                // [E] src/security/policy.ts RiskClass
  externalEffect: boolean;             // [E] same semantic as AuthorizationRequest.externalEffect
  occurredAt: string;                  // [E] RFC3339, validated like policy.ts invalid_timestamp
}

// [P] Decision — structurally parallel to PolicyDecision but local-signed.
export interface LocalPolicyDecision {
  requestId: string;
  accepted: boolean;
  reasonCodes: string[];               // [P] see vocabulary below
  ceilingDigest: string;               // [P] which ceiling version decided
  authorityDigest: string;             // [E] equals LeaseGrantBody.authorityDigest / envelope.digest
  requestDigest: string;               // [E] sha256Digest(LocalEffectRequest), mirrors PolicyDecision.requestDigest
  decidedAt: string;
}

// [P] Safe denial receipt — signable, journaled-safe (no secret material),
// sendable as protocol error or lifecycle event without leaking policy internals.
export interface LocalDenialReceipt {
  kind: "local_policy_denial";
  requestId: string;
  jobId: string;
  attemptId?: string;
  safeReasonCode: DenialCode;          // [P] constrained vocabulary, see below
  detailRedacted: boolean;             // [P] always true in v1 — no free-text detail leaves the node
  ceilingDigest: string;
  authorityDigest: string;
  requestDigest: string;
  deniedAt: string;
}

// [P] Trust/key-store availability gate — evaluated BEFORE policy, fail-closed.
export type KeyStoreAvailability =
  | { state: "available"; keystoreId: string; unlockedAt: string }
  | { state: "locked";    keystoreId: string; since: string }
  | { state: "error";     keystoreId: string; since: string; safeErrorCode: string };

export function evaluateLocalPolicy(
  ceiling: NodeLocalCeiling,
  authority: ReceivedAuthority,
  request: LocalEffectRequest,
  keystore: KeyStoreAvailability,
): LocalPolicyDecision; // pure, deterministic, no clock reads inside (occurredAt supplied)
```

**Denial-code vocabulary (Option A)** — strict subset/superset mapping to `OfferDecisionBody.safeReasonCode`: reuses `policy` as the umbrella plus adds node-local subcodes carried in a *separate* typed field, e.g. `detail: "risk_class_exceeded" | "executor_not_allowed" | "operation_not_allowed" | "network_destination_not_allowed" | "duration_exceeded" | "effect_policy_exceeded" | "external_effect_not_permitted" | "authority_expired" | "keystore_unavailable"`. Rationale: the wire enum is closed and server-owned [E types.ts L117]; extending it would break v1 schema negotiation, so node-local nuance must ride outside it or in a v2 field.

**Signing:** `LocalDenialReceipt` and `LocalPolicyDecision` are signed via `BridgeFrameSigner` [E bridge.ts L27]; their digests are journal-safe (hashes only, no material).

**Canonical serialization/digest needs:** reuse `sha256Digest` from `src/security/digest.ts` over sorted-key JSON, matching how `requestDigest` is computed today [E policy.ts L89]. Ceiling digest computed once at provision time and re-verified at load.

**Pros**
- Pure function ⇒ trivially property-testable; matches CR-4C/5A style (deterministic, injectable inputs).
- No new wire surface in v1; denials ride existing frames.
- Fail-closed ordering is structural: keystore gate → ceiling → authority → request.

**Cons**
- Ceiling provisioning path is new (who writes `NodeLocalCeiling`, and how its digest reaches Control Room for audit) — unresolved decision, owned by CR-6 packaging or later.
- Two vocabularies (wire safeReasonCode vs local detail) need a documented mapping table to avoid drift.

**Compatibility map**

| Contract element | Existing seam | Compatibility |
|---|---|---|
| Ceiling narrowing vs delegation | `compareDelegatedAuthority` violations list | Local ceiling plays "parent" role; any violation code reused verbatim keeps review symmetry |
| Decision shape | `PolicyDecision` | Same field grammar (reasonCodes/requestDigest) minimizes cognitive drift between server and node evaluators |
| Denial on wire | `OfferDecisionBody.safeReasonCode` | No enum change; detail rides in extension body rejected by v1 strict schemas ⇒ must be a *separate* frame type or deferred to v2 — flagged as open question |
| Signing | `BridgeFrameSigner` | Direct fit |

---

## Option B — "Server-mirrored grants" (node holds a signed grant slice)

The node stores a *signed projection* of its server-side `RoleGrant[]`, refreshed during reconciliation; local evaluation literally reuses `evaluatePolicy` semantics.

```typescript
// [P] Signed slice issued by Control Room, verified against the server trust bundle [E CR-5A].
export interface NodeGrantSlice {
  grantsVersion: number;               // [P] epoch, like leaseEpoch [E types.ts L129]
  grants: Array<Pick<RoleGrant, "id" | "allowedActions" | "projectIds" | "riskCeiling" |
                                "allowExternalEffects" | "requireStrongFactor" | "expiresAt">>; // [E] revokedAt omitted — server revokes by reissuing slices
  issuedAt: string;
  expiresAt: string;                   // [P] hard expiry independent of member grants
  serverSignatureOverCanonical: string; // [P] Ed25519 over canonical slice, server key
}
```

Evaluation then calls the *same* algorithm family as `src/security/policy.ts` with a node-local principal:

```typescript
// [P] Minimal principal standing in for AuthenticatedPrincipal [E policy.ts L5–17];
// strongFactor is structurally impossible locally (see impossibility table).
export interface NodePrincipal {
  tenantId: string;       // [E]
  identityId: string;     // [E] = nodeId
  actorType: "node";      // [E] literal already exists in the union
  authenticatedAt: string;// [E] = last successful connection.accepted time
  expiresAt: string;      // [E] = slice.expiresAt
}
```

Denials produce `PolicyDecision`-shaped objects mapped onto `LocalDenialReceipt` (identical receipt shape as Option A).

**Pros**
- One policy engine conceptually; least duplicated logic; strongest server/node symmetry.
- Grant lifecycle (revocation, expiry) inherits proven semantics instead of being reinvented.

**Cons**
- **Offline behavior is the killer:** a headless node that cannot fetch a fresh slice must either fail closed entirely when `grantsVersion` is stale (very availability-hostile) or honor stale grants (trust violation window). Neither choice is clean; this is the central unresolved tradeoff for Codex.
- Requires a new signed server→node artifact type (new frame or trust-bundle extension) — touches CR-5A territory.
- `requireStrongFactor` has no node-local meaning (no WebAuthn on a headless bridge) — dead field unless redefined.

---

## Option C — "Capability-token enforcement" (lease-bound local tokens)

Control Room embeds a fully-pre-decided capability token inside each `job.lease.grant`; the node merely *verifies* rather than decides. Local "policy" reduces to token verification + environment matching.

```typescript
// [P] Carried in LeaseGrantBody extension (v2 field) or sidecar frame.
export interface LeaseCapabilityToken {
  leaseId: string;            // [E]
  leaseEpoch: number;         // [E]
  jobId: string;              // [E]
  permittedOperations: string[];   // [P] exact, already narrowed server-side
  permittedExecutors: string[];    // [P]
  networkAllowlist: string[];      // [P] empty = no network
  externalEffectsAllowed: boolean; // [P]
  maxDurationSeconds: number;      // [E]
  notBefore: string; expiresAt: string; // [P]
  serverEd25519Signature: string;  // [P] over canonical token, verifiable via trust bundle [E CR-5A §6]
}
```

Node-side contract shrinks to:

```typescript
// [P] verification result; there is no local "decision engine", only match-or-deny
export interface CapabilityCheckResult {
  valid: boolean;
  failureDetail?: "expired" | "not_yet_valid" | "bad_signature" | "operation_mismatch"
    | "executor_mismatch" | "network_violation" | "epoch_mismatch";
}
```

**Pros**
- Smallest local attack surface; zero local policy drift possible; server stays single source of truth (aligns with CR-5B's "queueing is not permission").
- Trivially testable; receipts are just failed verifications.

**Cons**
- **No offline autonomy at all:** every capability is pre-enumerated server-side; a node mid-job whose renewal frame is lost cannot make even obvious safety-preserving local calls (e.g., refusing a destination clearly outside the original envelope — actually still fine since that's verification… but granting *anything* not pre-listed becomes impossible).
- Every operation change requires a new lease epoch ⇒ chatty protocol, more replay-window pressure.
- Weakest fit for "immutable node ceiling": ceiling degenerates into per-lease grants; nothing durable expresses what the *machine* will never do regardless of lease.

**Impossibility note (applies to all options):** node-side *approval evidence* (the strongFactor flow in `policy.ts` L76–83) can never be enforced locally in a cryptographically meaningful way — the human is on the server side of the trust boundary. Any local `approval_required` handling can only be "defer to server and wait," never "satisfied." Marked impossible-to-enforce rather than approximated.

---

## Cross-option comparison

| Dimension | A Ceiling-first | B Server-mirrored | C Capability-token |
|---|---|---|---|
| New wire surface | None (v1) or one v2 frame | Slice artifact (touches CR-5A) | Token in lease (v2 field) |
| Offline degradation | Full local judgment within ceiling | Stale-slice dilemma (fail-closed vs trust gap) | None — hard stop |
| Local autonomy | High | Medium | Minimal |
| Drift risk (node≠server logic) | Highest (two engines) | Lowest | Low (verification only) |
| Expresses machine-level ceiling | Yes, first-class | Indirectly | No |
| Test complexity | Property tests over pure fn | Reuses policy.ts tests + slice crypto | Simple verify tests |
| Fits "immutable local authority ceilings" (CR-5B stop-boundary language) | Best | Partial | Weakest |

## Impossible-to-enforce fields (any option)

| Field | Why impossible locally | Source |
|---|---|---|
| `strongFactor.*` satisfaction | Human presence is server-side; node cannot witness WebAuthn/passkey | policy.ts L11–16, L76–83 |
| True cost accounting (`maxCostUsd`) | Node cannot observe spend; can only enforce duration proxies | AuthorityEnvelope.maxCostUsd; authority.ts L25–26 |
| Revocation in real time | Revocation lives in DB; node learns via reconnect/reconciliation at best | CR-5A persistence tables; CR-5B reconciliation |
| `allowExternalEffects` ground truth | Node cannot verify where an effect *actually* lands, only whether it was declared | AuthorizationRequest.externalEffect semantics |

## What must be signed, and what is local-only

- **Signed (via BridgeFrameSigner):** decisions and denial receipts (all options); Option B adds server signature over the grant slice; Option C adds server signature over each token.
- **Local-only, never transmitted:** ceiling/grant-slice private material, resolved credential contents, raw policy internals beyond safe codes.
- **Journal-safe:** everything above except key material (already guarded [E journal.ts secret-material guard]); digests and receipts are explicitly designed journal-coexistent per CR-5B ("journal never stores private keys").

## Open questions owned by later blocks (not decided here)

1. Which option — or hybrid (e.g., **A's ceiling + C's lease tokens**: ceiling bounds what the machine may ever do; token bounds what this lease may do) — is Codex's call. Note the hybrid composes naturally and covers both dimensions.
2. Where `NodeLocalCeiling` provisioning happens (owner enrollment flow vs trust-bundle extension) → CR-6 packaging.
3. Whether denial-detail subcodes justify a v2 protocol field or ride as a new v1 frame type → protocol owner.
4. Offline staleness budget for Option B slices (if chosen) → scheduling/availability design.
5. Approval-required flows' UX on the node (wait vs reject-and-requeue) → CR-7 adapter layer.

*Every [E]-marked item cites the file and line range listed in Source seams. All [P] items are proposals only; none are implemented.*
