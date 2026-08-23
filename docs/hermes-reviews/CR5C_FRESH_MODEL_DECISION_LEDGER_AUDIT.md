# CR-5C fresh-model independent decision-ledger audit

**Work packet:** #59 (`[WORK][CR-5C] fresh-model independent decision-ledger audit`)
**Worker route:** Marvin / macOS Mac mini (M4 Pro, 48GB) / Hermes Agent — model `glm-5.2` via OpenRouter.
**Independence statement:** This model (GLM 5.2) did **not** author any of PRs #51–#56 and is not Ox Alpha. This is a genuinely fresh-model review. All six primary dossiers were read in full from PR branch heads before any comparison with PR #57. Conclusions below were derived independently; §9 diffs this ledger against #57's ranked defaults.
**Task class:** Documentation-only; high-reasoning independent review. No code, tests, migrations, config, live experiments, ADR, or merge.
**Repo state:** `main` post-#42 merge at `049bf80`; primary dossiers cited by PR SHA per §0.
**Allowed path:** `docs/hermes-reviews/CR5C_FRESH_MODEL_DECISION_LEDGER_AUDIT.md` only.

**Citation aliases:** CEIL=#55@`6fe740f` · STM=#51@`8ceb9f2` · ROT=#53@`41458d7` · ADM=#56@`48efbda` · RCPT=#52@`b2051cf` · DEST=#54@`dcce877` · CON=`CR5C_RESEARCH_CONTRADICTION_REVIEW.md` · ATX=`CR5C_ADVERSARIAL_TEST_MATRIX.md` · THM=`CR5C_NODE_LOCAL_THREAT_MODEL.md` · OPTS=`CR5C_LOCAL_POLICY_CONTRACT_OPTIONS.md` · SYN=`CR5C_CROSS_PLATFORM_KEYSTORE_SYNTHESIS.md` · INV=`CR5C_AUTHORITY_EFFECT_ENFORCEMENT_INVENTORY.md` · OPS=`CR5C_PLATFORM_OPERATIONAL_MATRIX.md` · TRACE=`CR5C_IMPLEMENTATION_REQUIREMENTS_TRACE.md` · LCY=`CR5C_BRIDGE_EXECUTOR_BOUNDARY_ANALYSIS.md` · 5B=`docs/CR5B_PORTABLE_NODE_BRIDGE.md`.

**Method note:** §1–§7 drafted from the six primary dossiers and merged reports alone. PR #57 was opened only for §9 comparison. Source line-pins re-verified against current `main`: `persistence.ts:73–84,199–207,242–261`; `state-machines.ts:74–82`; `redaction.ts:38–41`; `journal.ts:134–149,190–219,274`; `delivery-store.ts:112–141`; `canonical-store.ts:212–220,293–297`; `digest.ts:67+`.

---

## 0. Input verification

| Dossier | PR | Branch ref | Commit | Lines | Author | Post-repair? |
|---|---|---|---|---|---|---|
| Ceiling provisioning | #55 | pr-55 | `6fe740f` | 139 | Marvin (ox-alpha) | n/a |
| Expiry state machine | #51 | pr-51 | `8ceb9f2` | 214 | Ziggy (ox-alpha then grok-4.6) | yes — `[LCY]` alias repaired |
| Trust rotation | #53 | pr-53 | `41458d7` | ~170 | Johnny5 (ox-alpha) | n/a |
| Effect admission | #56 | pr-56 | `48efbda` | 110 | Marvin (ox-alpha) | n/a |
| Denial receipts | #52 | pr-52 | `b2051cf` | 220 | Ziggy (ox-alpha) | n/a |
| Destinations | #54 | pr-54 | `dcce877` | ~180 | Johnny5 (ox-alpha) | n/a |

STM post-repair verified: commit `8ceb9f2` corrected the `[LCY]` alias from nonexistent `CR5C_BRIDGE_LIFECYCLE_ANALYSIS.md` to `CR5C_BRIDGE_EXECUTOR_BOUNDARY_ANALYSIS.md`; grep confirms zero stale refs. The alias was defined but never used in body text — filename-only repair, semantics untouched. #51 is unblocked.

All six dossiers read in full. No dossier declared missing or skipped.

---

## 1. Ceiling provisioning

**Non-negotiable invariant:** A compromised Control Room signing key (THM T1) must not be able to *widen* a node's authority ceiling (ADR-009). Version monotonicity must be enforced outside the mutable ceiling artifact. Fail closed on missing, tampered, or rolled-back ceiling; never auto-regenerate (TRACE F-4).

**Strongest recommendation:** A+B hybrid — enrollment anchors the initial ceiling and provisioning-key pin (A); owner-signed config files enable cheap incremental rotation (B). Reject C (server-signed) as an authority mechanism; it may serve as relay transport only. D (platform-bound) is optional defense-in-depth.

**Strongest counterargument:** The hybrid's security rests on enrollment being a ceremony where the owner is present with a strong factor. But enrollment is server-mediated: `persistence.ts:76–84` shows the server creates the challenge and returns `serverTrustKeys` in the response; `persistence.ts:199–207` shows the server returns `initialGrant` and `initialGrantDigest`. If the ceiling bytes arrive inside this channel without an independent owner signature, the server can substitute its own ceiling and the node has no out-of-band reference to detect the swap. CEIL §1 Option A claims "Survives T1 completely: the server never participates in ceiling issuance, only witnesses the digest" — but witnessing is a server action inside a server-controlled transaction. The claim is overstated unless the ceiling artifact itself carries an owner-factor signature verifiable against a pin delivered independently of the server's response.

**Unproven assumption:** That a human with strong factor is always present at enrollment. No CR-5A document specifies what the human actually confirms during enrollment. If enrollment is ever automated (headless re-enroll, MDM-driven fleet expansion), A's trust anchor evaporates silently. Secondary assumption: that the provisioning key can be protected on all three hosts at least as well as the node identity key it outranks — no probe addresses this.

**Rollback/recovery concern:** Provisioning-key loss forces full re-enrollment, but re-enrollment through a compromised server is the exact T1 scenario being defended against. The recovery path crosses the adversary's hands. Without an out-of-band identity verification step (operator-present fingerprint comparison against a known-good value), recovery can widen the ceiling during the repair itself. CEIL §4 says "re-provision by signing anew" but does not address the compromised-server-during-recovery case.

**Falsifying test:** Enroll a node against a mock Control Room whose signing key differs from the real one. Feed a widened ceiling inside `initialGrant`. Assert the node refuses adoption unless the ceiling artifact carries an owner-factor signature verifiable against a pin delivered out-of-band (deploy config or operator transcript, not the enrollment response). If the node adopts, the A+B recommendation must be downgraded to B-primary with A as witness-only.

**Verdict:** Adopt A+B **with mandatory amendment**: ceiling bytes SHALL be signed by an owner/provisioning factor inside the enrollment payload; the provisioning-key pin SHALL reach the node via an out-of-band channel (deploy config, operator transcript, printed fingerprint), never solely inside the server's enrollment response. Without this amendment, A collapses to C-with-ceremony. This is a material repair to #55 as written.

---

## 2. Expiry / mid-execution revocation

**Non-negotiable invariant:** Evaluation is a pure function of supplied time (CON F2 repair). EXPIRED is locally terminal for new sub-effects. No transition skips AMBIGUOUS when an external effect may have fired (ATX 10b). Offline revocation is never instantaneous (CON F6; ADM I4).

**Strongest recommendation:** Adopt STM's B-2a/B-2b split — injected-clock clamp for evaluation (B-2a, pure function, property-testable) plus executor-owned monitor for mid-run expiry detection (B-2b, emits events into pure deciders). Effective deadline = `min(authority.expiresAt, lease.expiresAt)`. G0 hard-stop for v1.

**Strongest counterargument:** G0 maximizes AMBIGUOUS outcomes — the state with the worst operational properties (requires human or destination evidence to resolve). The "simplest" grace is operationally the most expensive. STM itself acknowledges this coupling in §3.2 but defers it to D-44-D. Additionally, `revocationDelayBound = 60s × k + reconciliation` (STM §4) is a formula with no values — every downstream document that cites an offline bound is currently quantifying nothing. The bound should not appear in any contract text until D-44-C assigns it a number and a measurement procedure.

**Unproven assumption:** That OS timers fire close enough to expiry for B-2b to be useful. STM labels timer-coalescing lateness as `[assumption]` and handles it fail-closed — acceptable in principle — but no measurement exists of actual lateness on macOS, Windows, or container Linux. If lateness is routinely seconds-scale, `EXPIRING_SOON` thresholds (D-44-F) tuned without that data will misfire in both directions: too tight causes spurious warnings, too loose makes the advisory window useless.

**Rollback/recovery concern:** The STM transition diagram shows a `renew(grant)` arrow into EXECUTING. STM prose restricts this ("applies only before EXPIRED") but the machine table — which is what gets coded — does not encode the restriction structurally. An implementer reading the table can treat a post-expiry renewal as resurrection. This must be encoded in the transition table itself, not in accompanying prose.

**Falsifying test:** Property test: for arbitrary authority/lease pairs and renewal grants applied after effective-deadline crossing, assert no path exists from EXPIRED to any non-terminal state. Kill-boundary: inject process death at every arrow in the transition diagram with simulated timer coalescing at 0ms/50ms/5s lateness — classification must be lateness-independent.

**Verdict:** Adopt B-2a/B-2b split unreservedly — it is the only coherent repair for CON F2. Conditionally adopt G0 **only if** ADM's ambiguity-resolution path ships in the same implementation slice. Forbid EXPIRED→EXECUTING in the transition table itself, not just in prose. Require a measured timer-lateness budget before any EXPIRING_SOON threshold is defaulted. Require D-44-C to produce a number before any contract text cites `revocationDelayBound`.

---

## 3. Trust rotation

**Non-negotiable invariant:** Retired/revoked server keys never reactivate (`persistence.ts:242–249` — DB models state transitions irreversibly). Trust data ≠ private-key storage (CON F8; ROT §1). Bundle shrink below ≥1 key forbidden without owner step-up (ROT §4.8). Offline revocation is delivery-bounded (CON F6).

**Strongest recommendation:** ROT Option B (signed monotonic bundles) + out-of-band pin at first enrollment (from D) + `valid_until` graft on keys (from C), checked under the same injected clock as STM B-2a. Reject routine re-enrollment (keep Option A as catastrophe fallback).

**Strongest counterargument:** The graft stack accretes complexity onto v1's frozen frame union: new bundle frame type, `valid_until` fields, epoch counters, shrink-counter signer — at minimum four schema events batched into one protocol-version tax. Each graft is individually defensible; jointly they raise the cost of getting v1 right and the blast radius of a frame-design mistake. The alternative — shipping B alone with short lease durations bounding offline exposure — may be honest enough without the graft, given that leases are already time-boxed (`canonical-store.ts:293–297`).

**Unproven assumption:** That the pin can be delivered out-of-band on all three hosts. On the VPS container there is no operator console moment; the deploy-config path assumes whoever writes the config isn't on the same compromised channel as the server. ROT names the bootstrap problem but provides no host-specific delivery story — this is the same family as CON F1/D6 (encrypted-file master-secret delivery). The pin's independence from the server's first message is the whole point; if the pin arrives inside the enrollment response, D-graft is theater.

**Rollback/recovery concern:** All-keys-lost → Option A re-enroll crosses the T1 adversary's hands (same flaw as ceiling recovery). Additionally, `valid_until` makes trust *clock-sensitive*: a node with a skewed clock ahead of truth refuses valid bundles (fail-closed, acceptable), but one skewed behind accepts expired keys until skew corrects — the fail-open direction needs an explicit skew-tolerance margin vs `valid_until` window. No margin is specified anywhere.

**Falsifying test:** Clock-skew fixture: node clock set +30min/-30min from truth, present a bundle whose `valid_until` falls between true now and node-now. Assert refusal in the fail-open direction (clock ahead) with a distinct safe code, and acceptance only within a documented skew margin. Plus ROT's own §4.9/§5.9 suite (epoch oracle, surviving-key signature, all-revoked fail-closed, crash fetch/apply, key-count floor).

**Verdict:** Adopt B + out-of-band pin. **Revise** the `valid_until` graft: require skew-margin design before adoption. Consider deferring `valid_until` to the first post-v1 protocol event if lease durations already bound offline exposure acceptably — Codex should decide with lease-length data in hand, not by default-grafting. Require pin-delivery story per host before B is declared deployable.

---

## 4. Effect admission / ambiguity

**Non-negotiable invariant:** I1–I6 (delivery dedup ≠ effect idempotency; serialize/refuse concurrent duplicates; pre-effect crash may re-authorize; post-effect/pre-ack crash → AMBIGUOUS unconditionally; settlement requires destination evidence; never claim exactly-once).

**Strongest recommendation:** J admission (durable claim rows in bridge journal) + D destination-idempotent resolution; E demoted to in-process optimization. Restart classification mechanical: `claimed`+no-executing-marker ⇒ safe re-dispatch; `executing` ⇒ AMBIGUOUS unconditionally.

**Strongest counterargument:** Against J+D: destination-idempotency resolution (D) presumes connectivity at resolution time, but the fleet's nodes go offline routinely (ROT/OPS backoff evidence). An ambiguous effect on a disconnected node waits indefinitely for a query the node cannot make. The honest answer is operator resolution or eventual connectivity — that should be stated as the contract, not papered over with "destination evidence resolves it."

**Unproven assumption — material defect in #56:** ADM §3 specifies `claim_key = sha256(nodeId ‖ messageId)`. This serializes redelivery of the same message, but at-least-once transport legally allows the server to re-offer the same effect under a fresh `messageId` after reconnect. The new message bypasses the claim row and double-fires. The admission key must be **effect-scoped** — `(nodeId, jobId, attemptId, operationDigest)` — with `messageId` demoted to a delivery-dedup secondary key. The `idempotency_key` field ADM proposes for destination resolution is correct, but the *admission* key (the one that prevents 9b concurrent fire) must not be message-scoped. This is a genuine defect in #56 as written.

**Second assumption:** That destinations which support idempotency keys honor them across retry windows comparable to node outage duration. No evidence exists about real destination behavior across multi-hour outages. D's reliability is asserted, never demonstrated.

**Rollback/recovery concern:** `effect_claims` rows accumulate forever absent a GC/retention policy. A journal bloat/failure mode mirrors W4's stuck-queued problem from LCY. Terminal claims need retention rules or the durability mechanism becomes its own availability risk.

**Falsifying test:** Deliver effect E under message M1, complete it, then have the server re-offer E under fresh message M2 (same jobId/attemptId/operationDigest). Assert gate refuses with `effect_in_progress` or terminal-replay, never fires. Under #56-as-written this test fails — the re-offer under M2 creates a new claim_key and bypasses the existing terminal row.

**Verdict:** Adopt J+D **as amended** — effect-scoped admission key `(nodeId, jobId, attemptId, operationDigest)`, messageId as delivery-dedup secondary, explicit statement that offline ambiguity resolves only via operator or eventual connectivity, and a retention policy for terminal claim rows. #56 requires this repair before merge.

---

## 5. Denial receipts

**Non-negotiable invariant:** No C5–C7 on the wire (policy internals, refused payload, free text/raw OS errors). Secret-guard universal (`redaction.ts:38–41`). Wire enum closed in v1 (`OfferDecisionBody.safeReasonCode`, 7 values). No stable ceiling identifiers.

**Strongest recommendation:** V2 two-tier vocabulary (coarse code on wire, node-private detail tier in local journal) + digest-normative ceiling identity + coalescing controls + E2 approval attestations with validity windows.

**Strongest counterargument:** RCPT §4's own honest finding is that digest-normative alone does not stop enumeration — within a static provisioning epoch, the digest *is* a stable pseudonym. Coalescing (§5) is the actual anti-enumeration control. But RCPT §5.1 and the synthesis both recommend shipping with coalescing **off** at first deploy for operational visibility. That means shipping the enumeration window open during the exact rollout period when operators most need visibility — trading one operational concern for the leak F3 exists to close. This is a genuine tension, not a bug; it deserves an explicit Codex trade rather than a silent default.

**Unproven assumption:** That probe-budget flattening (§5.2) can distinguish adversarial probing from legitimate varied workload. No corpus exists measuring how often honest multi-operation jobs produce N+ distinct denials in a window. If the threshold is too low, genuine failures get flattened into opacity.

**Rollback/recovery concern:** STM's richer lifecycle codes (`authority_expired_in_grace`) can leak grace policy if they reach the wire tier. RCPT's V2 two-tier design handles this in principle, but the boundary between local-detail and wire-code is easy to erode during implementation. Grace-band codes need explicit local-tier assignment.

**Falsifying test:** Replay a realistic mixed workload corpus through coalescing ON and assert zero genuine-denial information loss beyond the documented band structure. If flattening triggers below the adversarial budget, D-47-D defaults are wrong. Second: for every denial path, assert receipt ∩ (refused payload ∪ local config) = ∅ via fuzz.

**Verdict:** Adopt V2 + digest-normative + E2. **Revise** the coalescing default into an explicit Codex trade: enumeration-window-open (off) vs rollout-blindness (on). Run the probe-budget falsification test before any ON default is chosen. Treat 8-byte digest truncation (D-47-C) as join-key compression only — it confers no privacy and should be documented as such or dropped.

---

## 6. Destinations / network

**Non-negotiable invariant:** Authorization compares canonical forms only (ATX 3/5). D-4a (node connect-time identity pinning) proceeds regardless of D-4b (allowlist authoring owner) — CON F5 confirms four sources concur. Redirects never inherit authorization. Fail closed on canonicalization failure.

**Strongest recommendation:** C3 structured tuple as internal canonical representation (including digest input), R1 resolve-once pin + TLS cert verify, D-4a implement now, D-4b server-side normalization at authoring time.

**Strongest counterargument:** R1's pin is per-effect and dies with the process. Long-lived executors that re-resolve mid-run quietly reintroduce the rebinding window DEST exists to close — unless pin persistence is durable across process restarts within an effect's lifetime. DEST does not specify pin durability. Pin-without-durability is partial compliance presented as complete.

**Unproven assumption:** That TLS name verification is available to every executor in scope. DEST §5 admits non-TLS tools get IP-pin-only — a strictly weaker identity class — yet the dossier still counts D-4a as closing ATX case 5. It closes case 5 for TLS destinations only. Non-TLS executors (plain HTTP, custom TCP, browser-opaque tools) need either ceiling exclusion or a distinct weaker-class receipt code. DEST §6 says opaque tools "MUST be excluded from allowlist ceilings" but does not extend this to all non-TLS tools.

**Rollback/recovery concern:** C3-in-digest is a freeze-blocker: existing stored intents carry raw-string-derived digests (`digest.ts:67+` binds the raw string today). Migrating them is undesigned. If freeze happens before the migration design, C3 must be deferred wholesale and C1 (strict literal) kept as the wire-digest fallback — worse UX, but no schema break.

**Falsifying test:** DNS-rebinding fixture: executor resolves host, pin stored, TTL expires mid-run, resolver returns attacker IP. Assert second connection refused against pin. Then repeat with a non-TLS executor and assert the refusal reason code reflects the weaker identity class rather than claiming host-identity enforcement.

**Verdict:** Adopt D-4a/R1 for TLS destinations. **Revise** to require (1) durable pin storage spec before D-4a is declared closed, (2) a distinct weaker-class receipt code for non-TLS tools, (3) ceiling exclusion extended to all non-TLS executors unless Codex explicitly accepts IP-pin-only as a named weaker class. Defer C3-in-digest pending migration design; keep C1 fallback normative meanwhile.

---

## 7. S1/S2 contradiction findings review

**F2 (S1) — clock ambiguity:** Correctly diagnosed by CON: "own clock" was used for two different concerns (injected deterministic eval-time clock vs. real wall-clock monitoring between evaluations). STM's B-2a/B-2b split is the correct repair. **Residual gap:** no party owns measuring actual OS timer lateness. The repair is sound at the specification level; it is not yet backed by measurement. Status: repair sound, follow-up owed.

**F6 (S2) — offline revocation honesty:** The "revocation wins once delivered" restatement is the honest formulation. **Residual gap:** `revocationDelayBound` remains a symbol without a value across STM, ROT, and THM. Until D-44-C is numbered, any deployment claim of bounded revocation delay is unfalsifiable. Recommendation: Codex should refuse any contract text containing `revocationDelayBound` until it has a number and a measurement procedure.

Both S1/S2 items are genuinely resolved *at the documentation level*; neither is resolved at the level of measurable commitments. That distinction should be carried into the contract explicitly — "documented but unmeasured" is not the same as "done."

---

## 8. Cross-domain incompatibilities

These are tensions between domains that compose or conflict:

| Pair | Tension | Resolution |
|---|---|---|
| CEIL A+B × OPTS A+C | Two "hybrids" at different layers | Compose: CEIL provisions the machine ceiling; OPTS binds per-lease work. Do not pick one. |
| CEIL B file-drop × CON F1/D6 | Same unsolved Linux delivery problem | Decide D6 once; both consume the answer. |
| STM G0 × ADM ambiguity | Hard-stop produces more AMBIGUOUS | Decide together; do not ship G0 without ADM resolution path in the same slice. |
| STM B-2a clock × ROT `valid_until` | Trust becomes clock-sensitive | Same injected-clock fixture suite is mandatory for both. |
| STM renewal arrow × EXPIRED terminal | Resurrection bug | Forbid EXPIRED→EXECUTING in the transition table, not just in prose. |
| ADM `claim_key` × at-least-once new messageId | Double-fire hole | Tighten admission key to effect scope (§4). |
| ADM J "one writer" × LIFECYCLE v2 daemon | 9b re-opens if daemon splits writers | J requires shared writer; daemon implies different lock — decide before v2. |
| RCPT V3 × ROT new frame | Two protocol-version events | Batch or defer V3. |
| RCPT coalescing × first-deploy debug | Ops blindness vs enumeration window | Explicit trade; run falsification test before choosing default. |
| DEST C3-in-digest × existing raw-string digests | Schema/migration blocker | Freeze-blocker; otherwise keep C1 on wire digest. |
| DEST private-range deny × desktop loopback | Breaks local tools | Exception syntax required before default-deny ships. |
| SYN `verifyTrust` × ROT trust store | Interface coupling | Drop `verifyTrust` from NodeKeyStore (CON F8). |

---

## 9. Disposition of PR #57's ranked defaults

Derived independently above; then compared against PR #57's §5 ranked defaults:

| # | #57 default | This audit | Disposition |
|---|---|---|---|
| 1 | D-4a now | Adopt with revisions: durable pin storage + weaker-class codes for non-TLS | **Revise** |
| 2 | Drop `verifyTrust` | Agree — nothing in keystore capability probes supports trust lookup; CON F8 is authoritative | **Adopt** |
| 3 | B-2a/B-2b split | Adopt; add structural EXPIRED→EXECUTING prohibition + timer-lateness measurement requirement | **Adopt, strengthened** |
| 4 | Reject server-signed ceilings | Agree; strengthen: even A collapses toward C without owner-signature-inside-enrollment + out-of-band pin | **Adopt, strengthened** |
| 5 | J+D admission | Adopt **only with effect-scoped claim key** — #56-as-written fails the re-offer-under-fresh-messageId test | **Revise** |
| 6 | No stable ceiling ID | Adopt | **Adopt** |
| 7 | A+B ceiling hybrid | Conditional: owner-signed bytes inside enrollment + OOB pin mandatory, else drop A | **Revise** |
| 8 | ROT B+pin+`valid_until` | Skew-margin design required; consider deferring the graft if leases already bound exposure | **Revise** |
| 9 | V2 + coalescing off | Explicit-trade requirement; falsification test before any ON default | **Revise** |
| 10 | E2 attestation | Adopt | **Adopt** |
| 11 | G0 iff ADM resolution same-slice | Adopt; add structural EXPIRED→EXECUTING prohibition | **Adopt, strengthened** |
| 12 | C3-in-digest pre-freeze only | Adopt; add migration-design prerequisite | **Adopt, extended** |
| 13 | Private-range deny not fleet-default | Adopt | **Adopt** |
| 14 | Never claim offline revocation immediacy | Adopt; add "no unquantified `revocationDelayBound`" corollary | **Adopt, extended** |

**Convergence:** 8 adopt, 5 revise, 3 strengthened/extended (with overlaps). The two most important findings — CEIL Option A's conditional survival and ADM's claim_key scoping defect — are independently confirmed by both this audit and #57's own challenges. That two derivations from different starting points converge on the same two merge-blocking defects raises real confidence they are genuine.

**Where this audit diverges from #57:** #57 ranks D-4a unconditionally high (#1, "high confidence, blocked on nothing"). This audit insists on durable pin storage + weaker-class codes for non-TLS first, grounded in DEST §5's own honesty caveat. The disagreement is resolvable by Codex reading that single section.

---

## 10. Required repairs before merge

| PR | Defect | Repair |
|---|---|---|
| #55 (CEIL) | §1 Option A "Survives T1 completely" overstated; dot-score table shows ●●●● unconditionally | Footnote as conditional: survives T1 iff ceiling bytes are owner-signed inside enrollment + pin delivered out-of-band. Repair the dot-score table. |
| #56 (ADM) | §3 `claim_key = sha256(nodeId ‖ messageId)` fails at-least-once re-offer under fresh messageId | Change to effect-scoped: `claim_key = sha256(nodeId ‖ jobId ‖ attemptId ‖ operationDigest)`; messageId becomes delivery-dedup secondary key. Add the re-offer falsification test to §5. |
| #56 (ADM) | No retention/GC policy for terminal `effect_claims` rows | Add retention rule for terminal claims to prevent journal bloat. |

---

## 11. Acceptance self-checks

- Different model/profile: GLM 5.2 via OpenRouter — did not author #51–#56, not Ox Alpha ✔
- Six domains × (invariant, recommendation, counterargument, assumption, rollback concern, falsifying test) ✔
- S1/S2 findings reviewed with residual-gap identification ✔
- PR #57 disposition stated per-default with citations ✔
- Independent derivation performed before opening #57 ✔
- Source-linked disagreement for every revised default ✔
- Single allowed path; doc-only; no code/tests/migrations/config/ADR ✔
- `git diff --check` clean ✔

## Stop boundary

Read-only audit. Allowed path = this file. No merge. Unmerged dossier claims pinned to PR SHAs; source pins verified against current main. This document decides nothing — every verdict routes to Codex/Sol.
