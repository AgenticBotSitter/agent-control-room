# CR-5C denial-receipt privacy and anti-enumeration dossier

**Work packet:** #47 (`[WORK][CR-5C] denial-receipt privacy and anti-enumeration dossier`)
**Worker route:** Ziggy / Windows PC (RIG1) / Hermes Agent desktop — model route `stealth/ox-alpha` via Nous
**Task class:** Documentation-only; medium-risk security analysis. No protocol/code/migration changes, no secret-like fixtures, no live calls, no final ADR.
**Repo state analyzed:** `main` @ `489cd6d` + merged CR-5C report set.
**Purpose:** Close contradiction-review **F3** (S2: ceiling identifier vs digest leak channel) and **F9** (S3: approval-evidence verification ≠ witnessing). Design options for denial receipts that keep audit value without leaking ceiling/grant shape to a compromised server (THM T1) or a noisy caller.

**Primary citations:**
- **[CR]** = `CR5C_RESEARCH_CONTRADICTION_REVIEW.md` (F3, F9)
- **[ATX]** = `CR5C_ADVERSARIAL_TEST_MATRIX.md` case 11
- **[OPTS]** = `CR5C_LOCAL_POLICY_CONTRACT_OPTIONS.md` (#28)
- **[STM]** = `CR5C_EXECUTION_TIME_AUTHORITY_STATE_MACHINE.md` (#44)
- **[RED]** = `src/security/redaction.ts`; **[PROT]** = `src/node-protocol/v1/types.ts`; **[AUD]** = `CR5C_REPOSITORY_SECURITY_CONTROLS_AUDIT.md`
- All examples use symbolic data only (`<node-id>`, `<digest>`, `<ts>`).

---

## 1. Threat model for this document (scoped)

| Adversary | Capability | What they want from receipts |
|---|---|---|
| A1 Noisy legitimate caller | Sees own denials; can probe deliberately | Map the ceiling boundary by binary search over operation/target variants |
| A2 Compromised server (THM T1) | Reads every receipt the node sends | Infer policy surface: which operations exist, how fine the risk classes run, where limits sit |
| A3 Passive network observer | Sees frame metadata only | Traffic analysis of denial volume/timing |

Not in scope: same-UID local attacker (T2 territory [CR F7]; receipts give them nothing they don't already hold), side channels outside receipt contents.

Key asymmetry to design around: **the server both needs audit data and is the T1 adversary.** Receipt design must therefore be *useful-to-server but unhelpful-to-compromise* — granularity given away only when it earns its keep.

## 2. Data classification table

| Class | Examples | May appear in outbound receipt? | Rationale / source |
|---|---|---|---|
| C1 Public-safe codes | `authority_expired_local`, `policy_denied_local` | Yes | The whole point of safe vocabulary [ATX 11 invariant] |
| C2 Digests of refused material | `requestDigest`, `effectIntentDigest`, `ceilingDigest`, `authorityDigestAtFire` | Yes, with caveats (§4) | Digests are one-way; enable correlation without disclosure [OPTS Option A] |
| C3 Identifiers (stable) | nodeId, jobId, attemptId, requestId, offerId/leaseId | Yes (already on frames) | Needed for reconciliation; already public to server |
| C4 Timing/bucketed quantities | deniedAt; graceUsedSeconds as bucketed band; attempt counts | Yes if bucketed | Raw high-resolution values enable timing probes; buckets don't (§5) |
| C5 Policy internals | allowedOperations list, allowlist contents, risk thresholds, ceiling version number | **Never** | This is exactly what A1/A2 probe for [ATX 11: "none of … allowlist contents"] |
| C6 Refused payload content | arguments, targets, credentialRefs values | **Never** | Secret-guard domain [`RED assertNoSecretMaterial`] |
| C7 Free text / raw OS errors | any | **Never outbound** | [ATX 11; #47 acceptance] — local journal only, redacted per [RED] |
| C8 Approval evidence artifacts | server-signed attestations (F9) | Only as digest + validity status (§7) | Evidence itself is server's to hold; node proves possession/verification |

## 3. Safe code vocabulary options

The wire-level enum is closed in v1 (`OfferDecisionBody.safeReasonCode` has 7 fixed values [PROT types]). Node-local nuance must therefore either ride in digests or wait for v2. Three candidate vocabularies:

**V1 Coarse (reuse v1 enum verbatim).** Every local policy denial maps to existing `policy`; expiry to lifecycle event fields.
– Pros: zero wire change; minimal leak surface by construction.
– Cons: server audit can't distinguish failure families; debugging shifts entirely to node-side journals + manual fetch.

**V2 Two-tier (recommended candidate): coarse code on the wire + node-private detail tier.** Wire sees V1-grade codes plus digest set; the *detailed* reason (`operation_not_allowed` vs `risk_class_exceeded` vs `network_destination_not_allowed`) lives in the local audit journal, retrievable by operator action, never auto-transmitted.
– Pros: preserves ATX-11 minimality while keeping real auditability locally; matches F3's "rate-limit or coalesce" companion naturally.
– Cons: server-side dashboards are blinder than engineers might like — accepted trade.

**V3 Fine-grained extended enum (v2 field).** Add explicit subcode union to protocol.
– Pros: richest central telemetry.
– Cons: codifies the enumeration channel F3 warns about into the schema; every new code is a new probing signal. Requires strong rate-limiting to be safe at all.

Recommendation shape (not decided): **V2 now, V3 only if a demonstrated operational need survives the anti-enumeration test suite (§6)** — Decision D-47-A.

## 4. Stable ID vs digest — the F3 core

F3 asked: is the ceiling identified stably or by digest? Analysis:

| Property | Stable ID (`ceil-v3`) | Content digest (`sha256(canonical ceiling)`) |
|---|---|---|
| Correlating denials across attempts (audit value) | Trivial | Possible via digest equality — same content ⇒ same digest ⇒ same correlation power **within one provisioning epoch** |
| Attacker mapping ceiling via differential probes | Directly enabled: stable name + varied requests = clean oracle | Degraded: any ceiling edit rotates the digest; cross-epoch correlation requires the attacker to observe the rotation moment; within an epoch, digest is still a stable pseudonym — so digest alone does NOT solve enumeration |
| Revealing provisioning cadence | No | Yes (rotation events visible as digest change) — minor, arguably useful honesty |

**Honest finding:** F3's proposed correction ("adopt digest as normative") improves rotation hygiene but is **not sufficient against A1/A2 by itself** — within a static provisioning period the digest *is* a stable identifier. Anti-enumeration must come from §5 controls (coalescing/rate-limiting), not from the ID format choice. Both should ship: digest-as-normative (hygiene) + coalescing (actual defense). Decision D-47-B: adopt both together, never digest-alone.

Additional hardening option **[P]**: truncate transmitted ceilingDigest to a short prefix (e.g., 8 bytes) — enough for server-side join against the provisioning record it already holds, low-entropy enough to be useless as a cross-context correlator. Server holds the full digest from enrollment; only the node→server receipt path truncates. Decision D-47-C.

## 5. Correlation & anti-enumeration controls

Controls target A1 (probing caller) and A2 (compromised server reading volumes):

1. **Coalescing identical denials.** Same `(safeReasonCode, requestClassBucket)` denied repeatedly within window W ⇒ single receipt + local counter increment. Counter itself never leaves the node except as a bucketed count on operator demand. [Implements CR F3 "rate-limit or coalesce repeated identical denials".]
   - Window W and threshold: config, defaults open (D-47-D).
2. **Probe-budget response flattening.** After N distinct denied requests from one lease within window W, escalate responses to constant-shape: always `policy_denied_local` with zero detail fields regardless of true reason. The caller learns nothing further; genuine failures still land in local journal.
3. **No reflection rule.** Receipts never echo back parts of the refused request beyond its digest — even though echoing would help debuggers. Reflection is the classic oracle amplifier [ATX 11 "denied adversary learns only that it was denied"].
4. **Bucketed quantities only.** Durations/counters expressed as fixed bands (e.g., grace ∈ {none, ≤5s, ≤30s}) chosen so band edges don't align with policy thresholds.
5. **Volume symmetry.** Where feasible, deny paths should have comparable latency/size profiles so absence-of-detail isn't itself a signal (defense-in-depth; property P-5 asserts shape constancy).
6. **Cross-node independence.** No global counters shared across nodes (would create fleet-wide oracle); each node coalesces independently.

## 6. Local vs audit storage, signing, and what the server sees

### Storage split

| Store | Contents | Never contains |
|---|---|---|
| Outbound receipt (frame body) | C1+C2(truncated)+C3+C4-bucketed only | C5–C7 |
| Local audit journal (append-only, node-resident) | Full reason tier (V2 detail), raw-ish context redacted per [RED], coalescing counters, pre-fire triple outcomes | Key material, resolved secrets (journal guard [5B]) |
| Operator export (manual, signed by node key) | Selected audit-journal records + chain of receipt digests | Anything the operator didn't select |

Local journal entries chain via `prevEntryDigest` so an exported slice proves continuity without exposing unrelated entries — cheap integrity for the day someone audits a compromise.

### Signing

Receipts are signed via the existing `BridgeFrameSigner` seam [bridge.ts L27] exactly like other frames — no separate receipt-signing path (one signer, one trust story). Signature covers canonical receipt body including truncated digests; verification is standard CR-5A authenticator flow. Ambiguity-settlement receipts additionally reference the destination receipt digest [#44 §6], binding the settlement to external evidence.

### Server-visible vs node-only fields

| Field | Server sees | Node-only |
|---|---|---|
| Safe code | ✔ | ✔ |
| requestDigest / effectIntentDigest | ✔ | ✔ |
| ceilingDigest (**truncated**, D-47-C) | prefix | full digest + ceiling content |
| authorityDigest | ✔ (already on lease frames [PROT]) | envelope content |
| Detailed reason tier (V2) | ✖ | ✔ (journal) |
| Coalescing counters / probe-budget state | aggregate bands at most | ✔ exact |
| Approval-evidence verification result (§7) | status + evidenceDigest | evidence artifact itself stays with issuer/server |

## 7. Approval evidence: verification without exposure (F9)

F9 correction adopted as a design constraint: the node cannot *witness* strong-factor presence, but CAN verify a **server-signed approval attestation** attached to a frame [CR F9; INV B1/B2].

Flow options:

- **E1 Digest-match attestation.** Server attaches `{approvalId, effectIntentDigest, serverSig}`. Node verifies signature against trust bundle, checks digest equals its computed intent digest, proceeds/fails-closed. Receipts carry `approvalVerified=true|absent` boolean + `evidenceDigest` — never the artifact.
- **E2 Attestation with validity window.** E1 plus expiry inside the attestation, checked under the same injected-clock clamp as authority (B-2a pattern [#44 §2]) — prevents stale approvals being replayed onto new effects.

Candidate: **E2** (superset, same verification cost). Either way the privacy property holds: the human-approval artifact never transits through or resides on the node beyond its signed digest form; INV B1 verification stands offline; INV B3 fail-closed-on-absence maps to `approval_evidence_absent` denial code. Decision D-47-E: adopt E2 wording into the contract-options doc when Codex picks it up.

## 8. Property-test oracles

Each oracle is checkable without any real secret:

| Oracle | Statement |
|---|---|
| P-1 No-reflection | For fuzzed refusal corpus: receipt ∩ (refused payload ∪ local config) = ∅ [strengthens ATX 11 property to include config, not just payload] |
| P-2 Vocabulary closedness | Every emitted safeReasonCode ∈ closed union; fuzzing generator cannot produce others |
| P-3 Digest-prefix stability | Truncated ceilingDigest equal across denials in same epoch; differs across epochs (when fed synthetic rotations) |
| P-4 Coalescing idempotence | K identical denials in window ⇒ exactly 1 outbound receipt + counter=K−1; replaying the batch yields zero additional receipts |
| P-5 Shape constancy | Byte-length/field-presence profile of receipts constant across reason tiers (anti traffic-analysis seed) |
| P-6 Probe-flattening escalation | Distinct-denial sequence past budget N ⇒ all subsequent responses constant-shape regardless of input variety |
| P-7 Approval non-exposure | Given attestation-bearing frames, no receipt/journal output contains the artifact bytes, only digests/status [F9 guard] |
| P-8 Secret-guard universal | Every outbound receipt passes `assertNoSecretMaterial` [`redaction.ts:38-41`] — belt-and-braces re-check at the frame boundary |

## 9. Example receipts (symbolic data only)

Denial — operation outside ceiling (V2 two-tier):

```jsonc
// OUTBOUND (what server/T1 sees)
{
  "kind": "local_policy_denial",
  "requestId": "<req-id>",
  "jobId": "<job-id>",
  "attemptId": "<att-id>",
  "safeReasonCode": "policy",
  "detailRedacted": true,
  "requestDigest": "<sha256>",
  "effectIntentDigest": "<sha256>",
  "ceilingDigestPrefix": "<8-byte-hex>",
  "authorityDigest": "<sha256>",
  "coalesced": false,
  "deniedAt": "<ts>",
}
```

```jsonc
// LOCAL JOURNAL ONLY (never transmitted)
{
  "detailTier": "operation_not_allowed",     // V2 detail tier
  "requestedOperation": "<op-name-redacted-category>", // category, not value
  "fullCeilingDigest": "<sha256>",
  "probeBudgetState": { "distinctDeniedInWindow": 3, "windowExpiresAt": "<ts>" },
  "prevAuditEntryDigest": "<sha256>"
}
```

Expiry mid-execution (from #44 machine), with grace:

```jsonc
// OUTBOUND
{
  "kind": "attempt_lifecycle_event",
  "attemptId": "<att-id>",
  "safeReasonCode": "authority_expired_in_grace",
  "graceBandUsed": "le_5s",                  // bucketed, not raw seconds
  "latenessDeltaBand": "none",               // observation was timely
  "authorityDigest": "<sha256>",
  "occurredAt": "<ts>"
}
```

Approval-gated effect, evidence verified then settled:

```jsonc
// OUTBOUND at fire authorization
{ "kind": "effect_authorized", "attemptId": "<att-id>",
  "approvalVerified": true, "evidenceDigest": "<sha256>",
  "effectIntentDigest": "<sha256>", "authorizedAtInjected": "<ts>" }

// OUTBOUND after destination confirms post-ambiguity
{ "kind": "effect_settled_confirmed", "attemptId": "<att-id>",
  "destinationReceiptDigest": "<sha256>", "settledAt": "<ts>" }
```

## 10. Decisions for Codex

| ID | Decision | Notes |
|---|---|---|
| D-47-A | Vocabulary tier: V1 / **V2** / V3 | V3 gated on surviving P-4/P-6 suites |
| D-47-B | Adopt digest-normative **+** coalescing as a pair | F3 correction, strengthened per §4 honest finding |
| D-47-C | Truncate ceilingDigest on wire (prefix bytes) | Server holds full digest from enrollment |
| D-47-D | Coalescing window W + probe budget N defaults | Config surface owner |
| D-47-E | Approval attestation shape: E1 vs **E2** | Resolves F9 wording into contract doc |
| D-47-F | Audit-journal chaining (prevEntryDigest) normative? | Cheap integrity; small implementation cost |

## Acceptance self-checks

No free text or raw OS errors in outbound examples ✔ · symbolic fixtures only ✔ · exact citations throughout (file:line where source-backed) ✔ · assumptions labeled ✔ · `git diff --check`: clean at commit time ✔ · doc-only, single allowed path ✔

## Stop boundary

Read-only analysis; no protocol/code/migration touched; no secret-like fixtures created; no live calls; allowed path = this file only.
