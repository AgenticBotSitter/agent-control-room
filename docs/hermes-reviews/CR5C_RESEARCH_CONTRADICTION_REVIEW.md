# CR-5C independent contradiction review of the merged research batch

**Status:** Complete 2026-08-23
**Worker route:** Johnny5 / Debian 13 VPS / Hermes Agent — independent red-team review; medium risk; doc-only.
**Reviewer independence:** Johnny5 authored #13 (LNX probe), #29 (bridge lifecycle), #32 (fixture catalogue); did **not** author the eight primary reports reviewed here (#11 MAC, #12 WIN, #14 INV, #15 ATX, #16 THM, #17 SYN, #18 AUD, #27 TRACE, #28 OPTS, #30 PAUSE, #31 OPS). Where this review touches Johnny5's own reports, those findings are flagged as self-review and held to a stricter bar.
**Reports reviewed:** MAC (PR #19), WIN (PR #25), LNX (PR #24), INV (#20), ATX (#21), THM (#22), SYN (PR #26), AUD (#23), TRACE (#27), OPTS (#28), PAUSE (#30), OPS (#31). All were available; none skipped.
**Repo state analyzed:** `main` @ `489cd6d` plus the report branches as of 2026-08-23.

Severity scale: **S1** = would produce an unsafe implementation if uncorrected; **S2** = wrong or overstated claim needing correction before merge; **S3** = imprecision/ambiguity worth fixing; **NI** = checked, no issue (evidence cited).

---

## F1 — S1 · Encrypted-file master secret: "per-boot derivation" is asserted but no delivery mechanism exists on any probed node

- **Conflicting citations:** LNX §3.1 recommends "encrypted-file AES-256-GCM with per-boot master-secret derivation" [LNX]; SYN §0 adopts it as Linux's *primary* mode; OPS §2.2 marks master-secret delivery as "[assumption; mechanism = open decision D6]"; SYN D6 lists it as deferred.
- **Contradiction/overstatement:** SYN presents encrypted-file as "primary mode there [LNX §2, §3.1]" with confidence "High," while its own D6 defers the only hard part — how the master secret arrives at container start. A primary recommendation whose keystone is an open decision is overstated. TRACE F-3 then marks encrypted-file mode "**ready**" for CI without noting that boot-unlock (its actual deployment path) is not ready.
- **Failure consequence:** an implementer reads "ready + high confidence," builds unlock-at-start, and improvises the delivery — most likely via environment variable, which any same-container process or `/proc/<pid>/environ` reader can dump. That recreates exactly the T2/T3 exposure the design exists to prevent.
- **Proposed correction:** downgrade F-3 status to "ready for CI, decision-required for boot delivery"; add to TRACE a row under C (transport prerequisite): "master-secret delivery mechanism SHALL be decided (file-mount vs orchestrator-secret vs operator prompt) before encrypted-file mode is deployed outside CI." No probe contradicts this; all three reports agree D6 is open — the fix is purely in how SYN/TRACE word readiness.

## F2 — S1 · Local clock: three reports give three different answers about which clock decides execution-time expiry

- **Conflicting citations:** ATX case 2a invariant: "Expiry is enforced against the node's own clock even if the server's clock disagrees"; TRACE B-2 matches ("its **own clock**"). But frame-level auth already rejects expired frames against received-time skew windows (`authentication.ts:76-81`) where "node's own clock" means *receivedAt supplied by the caller*, and OPTS Option A specifies `evaluateLocalPolicy` takes "no clock reads inside (occurredAt supplied)". Meanwhile OPS §2.3 has mid-run keychain lock persisting "until process exit" with next unlock gating reconnection — implying wall-clock events can arrive asynchronously mid-job.
- **Contradiction:** "own clock" is used both for (a) an injected deterministic test clock at evaluation time and (b) real wall-clock monitoring between evaluations. These have different failure modes: an injected-clock gate never re-checks a lease that legitimately expires mid-execution unless something calls it again.
- **Failure consequence:** implementation follows the pure-function pattern (correctly, for testability) and nobody specifies the re-evaluation trigger — long jobs run past their authority window on the node while central enforcement assumes the node clamps locally (THM T8 mitigation claim).
- **Proposed correction/decision:** TRACE should split B-2 into B-2a (evaluation-time clamp, injected clock, property-testable) and B-2b (mid-execution re-check obligation — who calls the gate when the wall clock crosses expiresAt during a running effect; likely the executor wrapper, feeding ambiguity per I-1). This is a genuine spec gap none of the four authors flagged.

## F3 — S2 · Receipt secrecy: ATX case 11's "ceiling identifier" leaks policy surface that OPTS explicitly excludes

- **Conflicting citations:** ATX case 11 receipt contents: "message ref, safe reason code, **ceiling identifier**, timestamp." OPTS Option A `LocalDenialReceipt`: requestId, jobId, safeReasonCode, detailRedacted=true, ceilingDigest, authorityDigest, requestDigest, deniedAt — no ceiling *identifier*, and its prose says receipts must not leak "policy internals beyond safe codes."
- **Contradiction:** is the ceiling identified by stable ID (correlatable across denials, useful to an attacker probing where the boundary sits via binary search) or by digest of content (changes on every provisioning bump)? ATX implies the former; OPTS ships the latter without acknowledging the difference.
- **Failure consequence:** minor alone, but combined with denial receipts being new outbound traffic, an adversary with server compromise (T1) can map the local ceiling by differential denials if identifiers are stable and codes are fine-grained. The safe-code vocabulary granularity itself becomes the leak channel; no report analyzes enumeration rate.
- **Proposed decision/test:** adopt ceiling *digest* (OPTS shape) as the normative field; add one ATX-class property: "denial receipts over a probing sequence reveal no more than membership in a single ceiling version" — i.e., rate-limit or coalesce repeated identical denials.

## F4 — S2 · Duplicate-vs-effect ambiguity: my own #29 crash-window W2 conflicts with ATX case 9b serialization requirement unless specified further *(self-review, strict bar)*

- **Conflicting citations:** #29 §3 W2 says redelivery while a handler runs ⇒ "handler re-runs on the duplicate … at-least-once execution." ATX case 9b requires: duplicate arriving mid-execution "must serialize/refuse, not run concurrently." These are compatible only if the future executor holds a per-effect lock that survives process death ambiguously — but #29's seam proposal (`BridgeCommandGate`) runs *before* `markInboundProcessed`, meaning the inbox cannot yet distinguish "executing" from "received."
- **Consequence:** implementing the gate naively satisfies #29 and violates 9b.
- **Correction:** the gate contract needs an explicit `in-progress` disposition (or the executor claims effects via a journal row before returning from the gate). Routed to TRACE J-2 as a schema requirement; flagged here so the two documents are read together.

## F5 — S2 · Network canonicalization ownership: INV A4 says "decision required," TRACE D-4 repeats it, but ATX case 5 already commits the node to connect-time pinning regardless

- **Conflicting citations:** INV A4: "who canonicalizes destinations (server vs node)" flagged for Sol, do-not-resolve. ATX case 5 expected decision: "Host pinned at first resolution (connect-time re-verification) or rebinding treated as violation" — i.e., the *node* owns resolved-identity checking no matter what the server's allowlist semantics are. OPS §2 telemetry item 6 and THM T7 assume the same node-side guard.
- **Contradiction:** the "open decision" is framed as blocking D-4, but four reports independently put the load-bearing check on the node. The remaining server-side question (allowlist string canonicalization for effect-intent creation) is a different, narrower decision than D-4's framing suggests.
- **Consequence:** Codex could read TRACE D-4 as blocked-on-decision and defer the node guard entirely, leaving rebinding (THM T7) unmitigated while believing the inventory told it to wait.
- **Correction:** split D-4 into D-4a (node connect-time identity pinning — **ready**, no decision needed, four sources concur) and D-4b (server allowlist canonicalization owner — genuinely open).

## F6 — S2 · Trust rotation: SYN calls rotation "decision-required," but ATX case 8(b) already asserts revocation-beats-cache as an invariant — which is impossible without a rotation/distribution mechanism

- **Conflicting citations:** SYN D5/F-6/TRACE F-6: trust-bundle refresh "decision required," currently keys delivered once at enrollment (`persistence.ts:76-84,207`). ATX case 8(b): "(b) signing key present but marked revoked in bundle v2 while a v1-cached copy still verifies" expects revocation to win "without requiring connectivity" — but bundle v2 cannot reach the node offline by definition.
- **Contradiction:** the case-8b scenario requires the node to already hold v2; the only distribution path is connectivity. As written, 8b is untestable rather than fail-closed: after an offline period the node has only v1 and *cannot know* a v2 revocation exists.
- **Failure consequence:** a rehearsal of case 8b will either be quietly reinterpreted (bad precedent for the whole matrix) or expose that "revocation wins offline" (PAUSE acceptance test 7, TRACE G-2 analog for trust) is aspirational.
- **Proposed correction:** restate case 8b's precondition honestly: revocation beats cache *once bundle v2 is delivered*; offline the guarantee degrades to lease-expiry bounding (THM T8's existing position). Add to TRACE F-6's decision note: whichever mechanism is chosen must define a maximum revocation-propagation delay, and that delay bounds every offline-trust claim elsewhere in the batch.

## F7 — S2 · Local pause authority: PAUSE's recommended M-A socket grants pause power to "same UID," which is the same trust level as the bridge process itself (THM T2)

- **Conflicting citations:** PAUSE M-A assessment: peercred pins caller to OS UID *plus* separately protected operator factor — strong. But its own residual line concedes "attacker with same UID + keystore unlock capability defeats it." THM T2 defines compromised worker process = same UID = already holds node key + journal. The dossier's threat table row T2 says forged pause entries "need the factor" — yet the worker process can invoke the real CLI through the loopback socket with the unlocked keystore available to it.
- **Contradiction:** M-A's authentication strength rating (●●●●) is measured against T6 (other local user), but the fleet's stated top threat is T2 (compromised worker, same UID). Against T2, M-A ≈ M-C ≈ nothing: all are defeatable by the compromised process they'd be used to stop.
- **Consequence:** moderate — pause-as-kill-switch still works against external actors; but no report should claim the operator can reliably halt a compromised node from the node itself. Detection (signed journaled pause events) is the actual T2 control, and PAUSE does say that; its scoring table just doesn't propagate the caveat.
- **Correction:** add one sentence to PAUSE §4 summary: "No local mechanism defends against T2 (same-UID compromise); T2 containment remains detection-and-re-enrollment, not pause." Optionally route a remote/operator-held kill (revoke at server + lease non-renewal) as the honest T2 answer.

## F8 — S3 · Keystore scope drift: SYN's `NodeKeyStore.verifyTrust(ref)` silently expands the interface from key storage to trust-store authority

- **Citations:** SYN §1 interface includes `verifyTrust(ref)` described as "trust-store lookup for server-side public keys (CR-5A resolver contract)." Existing resolver is `TrustedKeyResolver` (`types.ts`), consumed by `NodeProtocolAuthenticator`, entirely separate from signer/key storage. TRACE F-1 copies the seven-method interface verbatim including verifyTrust.
- **Overstatement:** bundling trust resolution into the *keystore* couples two independently-evolving concerns and makes F-6 (rotation) look like a keystore feature when it is protocol/persistence territory. None of the three probes describes a platform keystore doing trust lookup — Keychain/DPAPI/encrypted-file store secrets; resolution is app logic.
- **Consequence:** low immediate, but interface freeze at CR-5C would embed the coupling; later splitting it breaks the "one contract" promise.
- **Correction:** drop `verifyTrust` from NodeKeyStore (keep six methods) or mark it explicitly as a composition convenience delegating to the existing resolver, not a keystore responsibility.

## F9 — S3 · OPTS impossibility table vs INV B2: "approval evidence can never be enforced locally" is right for satisfaction, wrong as stated for *verification*

- **Citations:** OPTS impossibility note: "Any local `approval_required` handling can only be 'defer to server and wait,' never 'satisfied.'" INV B1/B2 disposition says "**implement** node-side verification that its copy of the approval evidence matches the effect digest" and B3 says "fail closed locally when approval evidence is absent."
- **Tension:** these reconcile only if the node can carry a *server-signed attestation* of approval (verifiable offline) as distinct from witnessing the human action. OPTS's blanket phrasing would license an implementer to skip INV B1's node-side verification entirely.
- **Correction:** one clarifying sentence in either document: node cannot witness strong-factor presence, but CAN verify server-signed evidence artifacts attached to frames; INV B-row verification stands.

## F10 — S3 · OPS §2.4 Windows enrollment ordering: DPAPI protect-at-provisioning assumes provisioning happens in the enrolled user's session — unstated

- **Citation:** OPS §2.4 Windows row: "protect key blob via DPAPI CurrentUser at provisioning time [WIN §6.1]." WIN probe established DPAPI binds to the loaded user profile; if enrollment/provisioning ever runs elevated (admin install context) the blob encrypts under a different profile and first unlock fails confusingly (maps to `missing`/`permission-denied`, triggering re-enroll loops).
- **Consequence:** operational footgun during first rollout; cheap to prevent.
- **Correction:** add "provisioning SHALL run in the target user's interactive session, never elevated/install context" to OPS §2.4 and the WIN manual drill.

## F11 — NI checks (evidence-cited, no issue found)

| Check | Evidence | Result |
|---|---|---|
| Probe consensus: no native Linux keystore | LNX §2 (keyrings EPERM, no D-Bus/TPM/systemd) vs SYN §2 matrix vs OPS §1 table | Consistent across all three |
| Windows latency figure consistency | WIN §3.1 "~416 ms/op" vs OPS §1 "~416–437 ms/op" vs OPS §3 "win measured" | Same measurement family, no conflict |
| Queueing-is-not-permission framing | CR5B doc:70 vs INV F1 vs TRACE A-3 vs OPTS Option C rationale | All four align; no report treats queueing as authorization |
| Backpressure/reserve semantics | journal.ts:59-67 vs CR5B doc §Backpressure vs ATX §2.3 rows | Consistent; 64-frame essential reserve correctly carried |
| Replay exactness definition (messageId+nonce+connection+sequence+digest) | ADR-022 refs in INV E7, THM T4, and journal.ts:199-204 | Identical tuple everywhere |
| macOS service-context hazard (Aqua vs System domain) | MAC §5 vs OPS §2.1 hazard row vs SYN §2 service-context row | Consistent; OPS correctly carries it as documented, not inferred |
| Child-authority narrowing rule | authority.ts:18,25-26 vs ATX case 7 vs OPTS delegation mapping | Aligned; subset relation stated identically |
| Ack-loop prevention (acks untracked) | bridge.ts:235-241 trackAcknowledgement=false vs CR5B doc:40 | Consistent |

That is 8 substantive findings (F1–F8, incl. one self-review) + 2 operational corrections (F9–F10) + 8 no-issue checks = **18 recorded checks**, exceeding the 10 minimum.

## Ranked summary for Codex

| Finding | Severity | One-line action |
|---|---|---|
| F1 master-secret delivery | S1 | Mark F-3 decision-required for boot delivery; decide mechanism before non-CI use |
| F2 clock ownership split | S1 | Split TRACE B-2 into eval-time clamp + mid-run re-check obligation |
| F5 network pinning scope | S2 | Split D-4: node pinning is ready; only server canonicalization is open |
| F6 offline revocation honesty | S2 | Restate ATX 8b precondition; define max revocation-propagation delay |
| F3 receipt ceiling identifier | S2 | Norm = digest not stable ID; add anti-enumeration property |
| F7 pause vs T2 | S2 | State plainly: no local mechanism stops a same-UID compromise |
| F4 gate in-progress disposition | S2 | Extend gate contract/J-2 for effect-in-flight serialization (ATX 9b) |
| F8 verifyTrust scope | S3 | Remove or demote from NodeKeyStore interface |
| F9 approval verification wording | S3 | Clarify signed-evidence verification ≠ witnessing the human |
| F10 Windows provisioning session | S3 | Add interactive-session requirement to OPS/WIN drill |

## Stop boundary

Read-only review: source consulted for citation verification only; no probes, no network effects, no edits to other reports, no secrets, no merges. Allowed path touched: this file only.
