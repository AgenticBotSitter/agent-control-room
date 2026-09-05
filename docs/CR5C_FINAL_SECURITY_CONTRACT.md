# CR-5C final node-security contract

**Status:** Architect-frozen for implementation
**Decision date:** 2026-08-23
**Scope:** Node-local ceilings, protected key/trust interfaces, command admission, expiry, targets, effects, and safe denial receipts
**Authority:** This contract and ADR-023 through ADR-030 control CR-5C implementation. Research under `docs/hermes-reviews/` is evidence, not normative when it differs from this document.

## Outcome

A valid Control Room signature is necessary but never sufficient to make a node act. A node may execute only the intersection of:

1. an owner-signed, node-local maximum ceiling;
2. the complete authority carried in the current signed lease;
3. the registered typed executor's declared capability;
4. current local availability, pause, time, budget, target, and effect-admission checks; and
5. a separately verifiable approval attestation when the effect class requires one.

Any missing, malformed, stale, unmeasurable, non-canonical, or contradictory input denies execution. Queueing is never authorization.

## Threat boundary

CR-5C must contain a compromised Control Room application/server key from widening a machine's configured authority. It does not claim to contain:

- a process already compromised under the same OS identity as the bridge;
- an OS administrator or physical attacker;
- a malicious executor that lies about an effect after it receives authority; or
- instantaneous revocation while the node is disconnected.

Those residual risks are reduced by typed executors, OS account separation, short leases, durable effect claims, destination evidence, and later CR-5Q/CR-6 rehearsals. They are not described as solved.

## Frozen decisions

| Domain | Selected v1 rule | Rejected or deferred |
|---|---|---|
| Machine ceiling | Owner-signed ceiling plus an out-of-band provisioning-key pin and monotonic local high-water mark | Server-signed ceiling as authority; unsigned local config |
| Per-job authority | Full authority envelope inside every signed offer/grant; node computes a strict intersection | Digest-only authority; server decision as sufficient permission |
| Keys and trust | Separate private-key store, server-trust store, and owner-approval trust store | A single `NodeKeyStore` that also resolves trust |
| Server-key rotation | Owner-root-signed monotonic trust bundles; at least one active key; no online-key self-rotation | Silent key replacement; re-enrollment as routine rotation; `valid_until` in first v1 slice |
| Time | Pure injected-clock admission plus a runtime expiry monitor; effective deadline is the earliest applicable deadline | One-time admission check; post-expiry renewal resurrection; implicit grace |
| Effects | Durable effect-scoped claim plus pre-effect marker; ambiguous effects never auto-retry | Message-scoped claims; exactly-once claims; automatic retry from ambiguity |
| Approval | Separate owner/approval-key attestation for approval-required effects | Treating an online server assertion as proof of human presence |
| Receipts | Coarse fixed wire codes; detailed local-only reasons; no free text or ceiling internals on wire | Raw OS errors, refused arguments, stable ceiling identifiers, rich wire policy detail |
| Filesystem | Canonical real-path containment under explicit roots; symlink/reparse escape denied | Lexical prefix matching |
| Network | Canonical destination strings; HTTPS-only host identity in v1; connect-time address pinning; redirects re-authorized | Raw-string comparison; inherited redirect authority; claiming IP pinning proves TLS identity |
| Cost | Enforce only through a typed, monotonic local meter with reservable hard limits | Pretending an unobservable dollar cost is locally enforced |
| Local pause | Stops new admissions and requests safe cancellation; never claimed to defeat same-UID compromise | Sentinel-file-as-security-boundary |

## 1. Owner-anchored node ceiling

### 1.1 Normative artifact

The canonical ceiling body is `NodeAuthorityCeilingV1`:

```ts
interface NodeAuthorityCeilingV1 {
  schema: "control-room.node-authority-ceiling/v1";
  tenantId: string;
  nodeId: string;
  version: number;                 // positive, strictly monotonic
  issuedAt: string;                // canonical RFC 3339 UTC
  issuerKeyId: string;             // owner provisioning key
  projectIds: string[];
  executorIds: string[];
  operationIds: string[];
  credentialRefs: string[];        // references only
  filesystemRoots: string[];       // canonical platform paths
  networkDestinations: string[];   // canonical destination grammar below
  maxRisk: "low" | "medium" | "high" | "critical";
  externalEffects: "none" | "preauthorized" | "approval_required";
  maxDurationSeconds: number;
  maxConcurrentEffects: number;
  maxCostUsd?: string;             // canonical decimal; enforceable only with CostMeter
  bodyDigest: string;
}

interface SignedNodeAuthorityCeilingV1 {
  body: NodeAuthorityCeilingV1;
  signatureAlgorithm: "Ed25519";
  signature: string;
}
```

Arrays are sorted, unique, non-empty where the relevant feature is enabled, and included in canonical digest/signature input. Unknown fields fail validation. Wildcards are not supported in v1.

### 1.2 Provisioning and integrity

- The owner provisioning public-key pin must reach the node through a channel independent of the Control Room response: local operator configuration, deployment configuration already present on the machine, or an operator-verified fingerprint.
- The Control Room may relay the signed ceiling but cannot be its sole signer or trust-pin source.
- The node verifies signature, canonical digest, tenant/node binding, and `version > highWaterVersion` before adoption.
- The high-water mark is stored independently from the mutable ceiling file. Missing or rolled-back high-water state fails closed and requires owner recovery.
- Recovery and provisioning-key rotation require an owner-present, out-of-band confirmation. No server message may auto-regenerate or widen a ceiling.
- A same-UID compromise may still replace local state or invoke unlocked signers. CR-5C does not claim otherwise; CR-6 service isolation reduces this risk.

## 2. Lease authority and local intersection

Every `job.offer`, `job.lease.grant`, and renewal that can authorize work carries the complete canonical authority envelope, its digest, job/attempt/lease identifiers, lease epoch, and lease expiry inside the signed protocol frame. Digest-only grants are invalid.

Before admission, the node computes a strict intersection without inventing permissions:

- exact tenant, node target, project, job, attempt, lease, and epoch binding;
- executor and operation membership in both ceiling and lease authority;
- credential references, filesystem roots, network destinations, risk, external-effect policy, duration, concurrency, and measurable cost no broader than either source;
- authority expiry and lease expiry both valid;
- child/delegated authority no broader than its signed parent digest chain; and
- executor capability supports every requested control.

Risk uses the order `low < medium < high < critical` and the lowest maximum wins. External-effect policy uses the most restrictive applicable rule: `none` denies; otherwise `approval_required` requires an owner attestation; `preauthorized` permits only an exact operation/destination already present in both ceiling and lease authority. A lease can always narrow a ceiling from preauthorized to approval-required or none; it cannot move in the other direction.

An empty intersection denies. Unsupported wildcard, ambiguous target, unknown operation, missing meter, or an executor incapable of enforcing a requested restriction denies.

The local evaluator is a total, deterministic function. It receives `Clock`, normalized request, verified ceiling, verified lease authority, executor capability, availability, and optional approval evidence. It performs no I/O and never reads wall time internally.

## 3. Key and trust interfaces

Private signing, server trust, and approval trust are separate responsibilities:

```ts
interface NodePrivateKeyStore {
  reference(): KeyReference;
  availability(): Promise<KeyAvailability>;
  unlock(): Promise<void>;
  sign(bytes: Uint8Array): Promise<Uint8Array>;
  lock(): Promise<void>;
  dispose(): Promise<void>;
}

interface ServerTrustStore {
  currentEpoch(): Promise<number>;
  resolveServerKey(keyId: string): Promise<Uint8Array | undefined>;
  applyOwnerSignedBundle(bundle: OwnerSignedTrustBundleV1): Promise<void>;
}

interface ApprovalTrustStore {
  resolveApprovalKey(keyId: string): Promise<Uint8Array | undefined>;
}
```

No method exposes node private-key bytes to bridge callers. Private keys, resolved credentials, unwrap keys, and plaintext secret envelopes never enter PostgreSQL, SQLite journals, logs, receipts, Git, or artifact storage.

Native wrappers are preferred on macOS Keychain and Windows DPAPI CurrentUser. The portable encrypted-file provider is allowed only when its unwrap secret arrives through an operator-configured protected file/descriptor or platform secret facility outside the journal and repository. Environment variables and command-line arguments are forbidden as the default unwrap-secret transport. If no safe unwrap source exists, the bridge remains locked.

## 4. Owner-signed server trust bundles

`OwnerSignedTrustBundleV1` contains tenant/node-class scope, strictly increasing epoch, one or more active Ed25519 server public keys, retired/revoked key identifiers, issued time, owner-root key ID, canonical digest, and owner-root signature.

- The owner-root pin is provisioned out-of-band.
- Only a bundle with `epoch > currentEpoch` may apply.
- Revoked/retired keys never return to active state.
- A bundle may not leave zero active keys.
- Removing the last previously trusted active key requires an explicit owner countersignature/step-up represented in the bundle.
- Fetch and apply are crash-safe: verify completely, commit bundle and epoch atomically, then acknowledge.
- An online Control Room signing key cannot authorize its own replacement.
- `valid_until` is deferred until a measured clock-skew contract exists. Offline exposure is bounded only by already-held lease/authority deadlines; no stronger revocation-delay claim is made.

## 5. Time, expiry, and cancellation

Admission uses an injected clock. A runtime monitor emits time events into the same deterministic state machine; it does not make authorization decisions itself.

The effective deadline is the earliest of ceiling-imposed duration, authority expiry, lease expiry, approval expiry, and any executor reservation deadline.

- `EXPIRED` is terminal for admission and new sub-effects.
- Renewal received after expiry cannot resurrect an attempt; it requires a new attempt/effect identity.
- Before every external effect, the executor wrapper rechecks key availability, effective deadline, operation digest, local pause, and effect claim.
- On deadline crossing, no new effect may start. The wrapper requests cancellation of in-flight work.
- Cleanup after expiry is allowed only through separately typed, preauthorized cleanup operations that cannot create a new external effect.
- If the effect may already have fired, the result becomes `ambiguous`; expiry never licenses a blind retry.
- `EXPIRING_SOON` is advisory and has no authority. Its rollout threshold waits for measured platform timer behavior.
- While offline, the node can enforce local deadlines but cannot learn new server revocations. Long tasks must renew before the effective deadline or stop starting effects.

## 6. Durable effect admission and honest ambiguity

External effects require a durable effect-scoped claim. The canonical claim key is the digest of `(tenantId, nodeId, projectId, jobId, attemptId, operationDigest)`. `messageId` remains delivery-dedup metadata and never scopes effect identity.

Minimum states are `claimed`, `executing`, `confirmed`, `failed`, `cancelled`, and `ambiguous`.

- Claim creation is atomic and unique before executor dispatch.
- A duplicate with the same effect key serializes behind or replays the recorded disposition; it never runs concurrently.
- Immediately before crossing the external-effect boundary, the node durably records a pre-effect marker bound to the exact normalized operation, target, authority digest, claim key, and effective deadline.
- Under the honest executor contract, `claimed` without a pre-effect marker may be re-evaluated after restart; `executing` or a pre-effect marker without a terminal result becomes `ambiguous`.
- `ambiguous` never auto-retries. It resolves only from destination evidence or an explicit human decision recorded as a new authorized action.
- Destination idempotency keys use the same stable effect identity when supported, but Control Room never claims exactly-once external execution.

Non-terminal claims are never garbage-collected automatically. Terminal full records may compact to digest-only tombstones, but the tombstone remains for at least the maximum of the configured job retention, destination idempotency horizon, authority/lease late-delivery window, and protocol retry horizon. If any horizon is unknown, the tombstone is retained. Dropping a tombstone requires an explicit owner policy acknowledging possible very-late re-execution.

## 7. Approval attestations and review boundary

For `approval_required` effects, an online server assertion is insufficient under the compromised-server threat. The node requires an `OwnerApprovalAttestationV1` signed by a key in `ApprovalTrustStore`, distinct from ordinary Control Room online signing keys.

The attestation binds tenant, node or permitted node class, project, job, attempt, effect/operation digest, risk, decision, issued time, expiry, nonce, and approval-key ID. It is single-use per effect claim and expires before the effective deadline.

The node can verify the attestation; it cannot witness the human action itself. Until the CR-8 approval flow can produce this attestation, approval-required external effects remain disabled. AI pre-review may comment but cannot issue this attestation.

## 8. Target and network enforcement

### Filesystem

- Existing targets use platform canonical/real-path resolution before comparison.
- New-file targets canonicalize the nearest existing parent, then append a validated basename.
- Case rules follow the platform filesystem, not string assumptions.
- Symlink, junction, reparse-point, `..`, alternate separator, encoding, or mount escape outside an allowed root denies.
- Destructive recursive operations remain separately governed by the executor contract and are not implied by root membership.

### Network

The v1 canonical destination is an exact tuple serialized as `https://<ascii-host>:<port>` with normalized IDNA host, explicit port, no userinfo, path, query, fragment, wildcard, or implicit redirect authority. The canonical tuple is included in operation/authority digests. Existing non-canonical strings are rejected rather than silently reinterpreted.

- HTTPS is the only generally authorized network class in v1.
- The node resolves the canonical host, rejects prohibited address classes unless the local ceiling contains an exact typed exception, and pins the selected address set for the effect/connection lifetime.
- TLS certificate hostname verification remains required against the canonical host; IP pinning alone is not host identity.
- Every redirect is a new destination and must pass authorization independently.
- Pin state needed across a recoverable long-lived effect is stored as non-secret claim metadata.
- Plain HTTP, custom TCP, opaque browser networking, and executors that cannot expose their final destination are denied unless a future typed weaker network class is explicitly added to both the ceiling and executor contract.
- Real DNS/TLS rebinding proof remains a CR-6 integration rehearsal; unit tests use symbolic resolvers and sockets.

## 9. Denial receipts and privacy

Local policy keeps detailed reason codes and full decision digests in the protected local journal. The wire emits only a fixed coarse category such as `policy`, `expired`, `approval_required`, `effect_in_progress`, `ambiguous`, `maintenance`, or `storage` plus message/job/attempt references already known to the server, a receipt ID, and timestamp.

Wire receipts contain no:

- free text or raw OS/library errors;
- refused arguments, targets, credential references, local paths, allowlist contents, or local ceiling details;
- stable ceiling identifiers or ceiling digests; or
- approval evidence beyond its already-known operation binding and safe status.

Every receipt passes the secret-material guard before journal/outbox insertion. Repeated denials are locally rate-limited and coalesced into the same coarse category while complete local evidence is retained. Exact numeric limits are deployment policy and must be set before live rollout; disabling the limit is not a valid production setting.

## 10. Cost, availability, and pause

- `maxCostUsd` is locally enforceable only when the typed executor supplies a monotonic `CostMeter` with atomic reservation and reconciliation. Without that capability, any request whose correctness depends on a dollar limit denies.
- Duration, concurrency, disk reserve, key-store availability, and executor availability are locally measurable and fail closed at admission.
- Local pause immediately blocks new admission and renewal, records a local audit event, and requests typed cancellation/drain for running work. A potentially fired effect follows ambiguity rules.
- A same-UID compromised worker can defeat an in-process or same-UID pause. Service stop/account isolation and central lease non-renewal are the honest containment controls for that threat.

## 11. Required implementation order

1. Canonical schemas, signed ceiling, complete lease authority, approval attestation, and trust-bundle types.
2. Protected-store interfaces and deterministic in-memory test doubles.
3. Ceiling/trust persistence with monotonic high-water checks.
4. Pure authority intersection and safe receipt builder.
5. Bridge-to-executor admission seam and durable refused/claimed states.
6. Expiry monitor and terminal transition rules.
7. Filesystem/network target guards.
8. Effect claims, pre-effect markers, ambiguity, and tombstones.
9. Platform providers and manual rehearsals.

No downstream slice may redefine a frozen type or weaken an invariant to make an adapter easier.

## 12. Acceptance gates

CR-5C completes only when tests prove:

- a valid server signature cannot widen the owner ceiling;
- tampered, missing, or rolled-back ceiling/trust state fails closed;
- a lease carries complete canonical authority and intersects strictly;
- expiry is checked at admission and immediately before effects, with no resurrection;
- fresh-message re-offers map to the same effect claim;
- concurrent duplicates do not execute together;
- every post-effect/pre-terminal crash becomes ambiguous and never auto-retries;
- filesystem traversal/symlink/reparse and network redirect/rebinding fixtures deny safely;
- approval-required effects cannot run with only an online server assertion;
- denial receipts leak none of the refused request, local ceiling, secrets, or raw errors;
- unmeasurable cost constraints deny; and
- exact retry/replay behavior from CR-5A/5B remains unchanged.

Real PostgreSQL concurrency, process-kill boundaries, native key-store prompts/service contexts, and live DNS/TLS behavior remain explicit CR-5Q/CR-6 gates. They may not be represented as passing based on PGlite or test doubles.

## 13. Deliberately deferred decisions

- numeric lease/offline limits, denial coalescing thresholds, and terminal tombstone duration;
- `valid_until` server-key semantics until measured clock-skew policy exists;
- non-TLS network classes;
- grace beyond preauthorized no-effect cleanup;
- platform service packaging and same-UID isolation;
- live approval issuance UX and Telegram/dashboard flows; and
- destination-specific idempotency evidence.

These are deployment or later-block settings. None may silently weaken the contract defaults: missing values fail closed.

## 14. CR14C typed payload commitment extension

Native task integration adds an optional SHA-256 `payloadDigest` to normalized local requests and
pre-effect operation material. When present it participates in the existing normalized operation
digest and therefore the owner approval and effect claim. Native start requires it; the typed native
binding verifier must recompute it from exact input, enrollment, lease and authority/deadline material.
Legacy operations without the field keep their prior digest material. Unsupported nodes refuse the
extended native request; dropping the commitment is forbidden. This extension supplies no execution
authority and does not replace any signature, ceiling, current-state or pre-effect check above.
See `CR14C_NATIVE_TASK_APPROVAL_BINDING_CONTRACT.md` for material and evidence boundaries.
