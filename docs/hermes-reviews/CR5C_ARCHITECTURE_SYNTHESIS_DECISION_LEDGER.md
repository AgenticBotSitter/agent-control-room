# CR-5C independent architecture synthesis and decision ledger

**Work packet:** #49 (`[WORK][CR-5C] independent architecture synthesis and decision ledger draft`)
**Worker route:** Ziggy / Windows PC (RIG1) / Hermes Agent desktop — model `grok-4.6` via `xai-oauth` (different family from the ox-alpha primary-dossier wave)
**Task class:** Documentation-only; high-risk independent review. No code, no final ADR, no merge.
**Repo state:** `main` @ `049bf80`. Primary dossiers consumed from unmerged PR heads (all six exist).
**Purpose:** Synthesize the six primary dossiers + merged CR-5C evidence into a Codex decision ledger. Rank viable choices and name incompatibilities. **Does not decide on Codex's behalf.**

**Independence / self-review:** This agent authored **#44 (PR #51)** and **#47 (PR #52)**. Those two domains are flagged **self-review, stricter bar** below: challenges target *my own* recommendations, not just siblings. The other four dossiers (#43/#45/#46/#48) were authored by Marvin or Johnny5.

**Citation aliases:**
- **CEIL** = PR #55 / `CR5C_CEILING_PROVISIONING_DOSSIER.md` @ `6fe740f`
- **STM** = PR #51 / `CR5C_EXECUTION_TIME_AUTHORITY_STATE_MACHINE.md` @ `0ec824d` *(self)*
- **ROT** = PR #53 / `CR5C_SERVER_TRUST_ROTATION_OPTIONS.md` @ `41458d7`
- **ADM** = PR #56 / `CR5C_EFFECT_ADMISSION_AMBIGUITY_DOSSIER.md` @ `48efbda`
- **RCPT** = PR #52 / `CR5C_DENIAL_RECEIPT_PRIVACY_DOSSIER.md` @ `b2051cf` *(self)*
- **DEST** = PR #54 / `CR5C_DESTINATION_CANONICALIZATION_DOSSIER.md` @ `dcce877`
- **CON** = `CR5C_RESEARCH_CONTRADICTION_REVIEW.md` (merged PR #42)
- **TRACE** = `CR5C_IMPLEMENTATION_REQUIREMENTS_TRACE.md` · **OPTS** = `CR5C_LOCAL_POLICY_CONTRACT_OPTIONS.md` · **ATX** = `CR5C_ADVERSARIAL_TEST_MATRIX.md` · **THM** = `CR5C_NODE_LOCAL_THREAT_MODEL.md` · **SYN** = `CR5C_CROSS_PLATFORM_KEYSTORE_SYNTHESIS.md` · **INV** = `CR5C_AUTHORITY_EFFECT_ENFORCEMENT_INVENTORY.md` · **OPS** = `CR5C_PLATFORM_OPERATIONAL_MATRIX.md` · **5B** = `docs/CR5B_PORTABLE_NODE_BRIDGE.md`
- Line refs into `src/` are pinned to `main` @ `049bf80`.

---

## 0. Input inventory

| Domain | Packet | PR | Status at synthesis | Missing? |
|---|---|---|---|---|
| Ceiling provisioning | #43 | #55 | available (unmerged) | no |
| Expiry / mid-run revocation | #44 | #51 | available (unmerged) | no — **self-authored** |
| Trust rotation | #45 | #53 | available (unmerged) | no |
| Effect admission / ambiguity | #46 | #56 | available (unmerged) | no |
| Denial receipts | #47 | #52 | available (unmerged) | no — **self-authored** |
| Destinations / network | #48 | #54 | available (unmerged) | no |

All six primary reports exist. Synthesis proceeds. Unmerged status is an assumption: claims about those files are pinned to the PR SHAs above, not to `main`.

---

## 1. Conflict table (sources that disagree)

| Topic | Source A | Source B | Nature | Ledger resolution |
|---|---|---|---|---|
| Which clock decides expiry | ATX 2a / TRACE B-2: "node's own clock"; OPTS A: injected `occurredAt`, no clock reads inside | OPS §2.3 mid-run lock is a wall-clock event | CON F2: two different clocks collapsed into one phrase | Adopt STM's B-2a/B-2b split; TRACE B-2 is not implementation-ready until split |
| Offline revocation wins | ATX 8b / TRACE G-2 analog: revocation beats cache without connectivity | CON F6 / ROT §1: bundle v2 cannot reach an offline node | Unreachable invariant | Restate: revocation wins **once delivered**; offline bound = lease expiry (+ optional key `valid_until`) |
| Ceiling identifier on receipts | ATX 11: "ceiling identifier" | OPTS A: `ceilingDigest`, no stable ID | CON F3 | RCPT: digest-normative **and** coalescing; digest-alone is insufficient (stricter than CON F3) |
| Duplicate mid-execution | LIFECYCLE #29 W2: handler re-runs (at-least-once) | ATX 9b: serialize/refuse, never concurrent | CON F4 | ADM J-admission + D-resolution; gate needs `in-progress` |
| Who canonicalizes destinations | TRACE D-4 / INV A4: decision-required monolith | ATX 5, THM T7, OPS §2, DEST: node owns connect-time pin | CON F5 | Split D-4a ready / D-4b open; DEST specifies D-4a |
| Local approval enforcement | OPTS impossibility: never "satisfied" locally | INV B1/B2: node verifies approval evidence | CON F9 | RCPT E1/E2: verify server-signed attestation; do not witness the human |
| Trust lookup home | SYN §1 `NodeKeyStore.verifyTrust` | CON F8 / ROT §1: trust store ≠ keystore | Interface coupling | Drop `verifyTrust` from NodeKeyStore; ROT is authoritative |
| Encrypted-file "ready" | SYN §0 / TRACE F-3 tone | CON F1 / OPS D6: delivery mechanism open | Readiness overstated | Boot delivery remains decision-required (not a #49 domain, but blocks ceiling file-drop on Linux) |
| Ceiling hybrid vs lease hybrid | OPTS: A-ceiling + C-lease-tokens | CEIL: A-enrollment + B-owner-signed-file | Compatible, easy to confuse | Different layers: CEIL A+B provisions the *machine ceiling*; OPTS A+C binds *per-lease* work. Compose, do not pick one hybrid |
| Expiry grace vs ambiguity | STM D-44-D G0 hard-stop (self) | ADM: every hard abort mid-effect raises AMBIGUOUS | Hidden coupling | If G0 ships, ADM kill-boundary load rises; decide together |
| Digest input for destinations | `digest.ts:67+` binds raw string today [DEST §2] | DEST C3: shared tuple must feed the digest | Schema-affecting | C3-in-digest must precede freeze or be rejected |

---

## 2. Overstatements to refuse (do not implement as written)

| Source | Overstatement | Why it is unsafe | Honest restatement |
|---|---|---|---|
| ATX 8b | Revocation beats cached trust without connectivity | No delivery path exists [CON F6, ROT §1] | Wins after bundle delivery; offline = lease/`valid_until` bound |
| ATX 11 | Receipt includes a "ceiling identifier" | Stable ID is an enumeration oracle [CON F3, RCPT §4] | Digest (optionally truncated) + coalescing; never a stable name |
| OPTS impossibility table | Local approval "can never be enforced" | True for *witnessing*, false for *verification* [CON F9] | Node verifies server-signed evidence; cannot satisfy strongFactor |
| SYN/TRACE F-3 readiness | Encrypted-file mode "ready"/high confidence | Master-secret delivery is open [CON F1] | Ready for CI; not for boot outside CI until D6 |
| SYN §1 | `verifyTrust` is a keystore method | Couples independent stores [CON F8, ROT §1] | Trust resolution stays in protocol/app logic |
| TRACE B-2 "ready" | Own-clock expiry is implementation-ready | Collapses eval-time vs mid-run [CON F2] | Ready only after B-2a/B-2b split (STM) |
| TRACE D-4 "decision-required" as a block | Whole network row waits on Sol | D-4a is ready [CON F5, DEST] | Only D-4b (allowlist authoring) is open |
| CEIL Option A | "Survives T1 completely: the server never participates in ceiling issuance" | Enrollment is a server-mediated ceremony (`persistence.ts:76–84,199–207`) | Survives T1 **iff** the ceiling bytes are owner-signed (or owner-factor-bound) *inside* the enrollment payload, not merely digest-witnessed by the server |
| ROT §4.4 | Connected nodes converge "within one fetch interval" | A node can be TCP-up and still `backing_off` [5B / OPS §2.3] | Bound applies only after a successful authenticated fetch, not "connected" loosely |
| ADM §1 J | "SQLite single-writer gives serialization for free" | True for today's one-process journal [5B]; false if LIFECYCLE's v2 executor-daemon lands | J holds only while claim rows and the gate share one writer; daemon split re-opens 9b |
| RCPT §2 C2 *(self)* | Digests "are one-way; enable correlation without disclosure" | An 8-byte prefix is not one-way in any strong sense; within an epoch the full digest is a stable pseudonym [RCPT §4, which already contradicts the C2 one-liner] | Treat transmitted prefixes as join keys, not as privacy |
| DEST §7 | Node network denial is "advisory to the audit trail, not a protocol error frame" | Advisory denial + continue-the-effect would violate fail-closed / THM T7 | Locally fail closed always; "advisory" describes *wire visibility*, not *whether the effect proceeds* |

---

## 3. Domain ledgers

Each domain: options → non-negotiable invariants → dependencies → owner decision → recommended default + confidence → rollback → tests → **independent challenge**.

### 3.1 Ceiling provisioning

**Options (CEIL §1):** A enrollment-bound · B owner-signed config file · C server-signed artifact · D platform-bound (MDM/GPO/container labels).

**Non-negotiable invariants**
- A compromised Control Room key (THM T1) must not be able to *widen* a ceiling (ADR-009; CEIL §0).
- Version monotonicity + high-water mark outside the mutable file (CEIL §2).
- Fail closed on missing/tampered/rollback; never auto-regenerate (TRACE F-4 / CEIL §4).
- Ceiling bounds the *machine*; leases bound the *job* (OPTS hybrid; CEIL §3).

**Dependencies:** owner/provisioning key protection (CEIL B) shares the unsolved *delivery* problem with CON F1 / SYN D6 on Linux. Integrity MAC needs a keystore-held secret (SYN §1 unlock). Audit `ceiling_adopted` events need a receipt path (RCPT / TRACE H).

**Owner decision (Codex):** mechanism. CEIL leaves A+B hybrid + D hardening as a *shape*, not a pick. Extra: is the provisioning key the same as the pause-operator key (#30)?

**Recommended default (not an ADR):** **A+B** — enroll the initial ceiling + provisioning-key pin; rotate via owner-signed increments. **Reject C as authority** (relay-only). D optional per-platform hardening. Confidence: **medium-high** on rejecting C; **medium** on A+B (Linux file-drop = D6).

**Rollback story:** high-water + `prevCeilingDigest` refuse downgrade. Lost provisioning key → re-enrollment (A). Corrupt local state → fail closed, re-provision, never widen-by-default.

**Exact tests:** CEIL §6.1–6.7 (field tamper, replay-old-version, secret-guard fuzz, widened-job refuse, offline rotation, kill between verify and high-water commit, per-host delivery drill).

**Independent challenge:** CEIL's "A survives T1 completely" is overstated (table above). If Codex picks A, require the ceiling artifact itself to be owner-factor-signed *inside* enrollment, not a server-witnessed digest of a server-supplied blob. Otherwise A collapses to C with extra ceremony.

### 3.2 Expiry / mid-execution revocation *(self-review)*

**Options (STM):** B-2a injected-clock clamp + B-2b executor-owned monitor; grace G0/G1/G2; effective deadline = `min(authority.expiresAt, lease.expiresAt)`.

**Non-negotiable invariants**
- Evaluation is a pure function of supplied `now` (OPTS A; CON F2).
- Mid-run crossing must be *someone's job* (B-2b); a one-shot clamp is not enough [CON F2 failure mode].
- Offline server-revocation is **not instantaneous** (packet #44 acceptance; CON F6; ROT R1).
- No transition skips AMBIGUOUS when an external effect may have fired (ATX 10b; STM §1 rule 4).
- EXPIRING_SOON is advisory and must not authorize anything ADMITTED would refuse (STM §1 rule 3).

**Dependencies:** ADM's claim/proof row is the crash classification input (STM "pre-effect proof" ≈ ADM `effect_claims`). ROT graft-3 `valid_until` makes the same clock clamp load-bearing for *trust*. RCPT needs `authority_expired_local` / `_in_grace` codes. Grace G1/G2 needs destination capability metadata ADM says does not exist.

**Owner decision:** D-44-A (monitor owner) · D-44-C (`revocationDelayBound`) · D-44-D (grace) · D-44-F (EXPIRING_SOON threshold). D-44-B mid-attempt authority swap = out of v1.

**Recommended default (not an ADR):** adopt B-2a/B-2b split; **G0** for v1; `revocationDelayBound` named and cited everywhere offline-trust is claimed. Confidence: **high** on the split (only repair for F2); **low-medium** on G0 — see challenge.

**Rollback story:** EXPIRED is locally terminal for *new* sub-effects; already-fired work settles via ADM ambiguity, not by resurrecting authority. A later lease renewal must not move EXPIRED → EXECUTING (STM diagram's "renewal re-arms" arrow is easy to misread — it applies only *before* EXPIRED).

**Exact tests:** STM P-1..P-4, U-1..U-4, K-1/K-2.

**Independent challenge (stricter, own work):**
1. G0 maximizes AMBIGUOUS tails that ADM then cannot locally resolve. Shipping G0 without committing ADM's operator-resolution path is an incomplete safety story.
2. The STM diagram shows `renew(grant)` re-arming EXECUTING; an implementer can treat a post-expiry renewal as resurrection. Codex should forbid EXPIRED→EXECUTING in the table, not just in prose.
3. `revocationDelayBound = 60s × k + reconciliation` is not yet a number. Until D-44-C has a value, every "offline bound" claim in ROT/THM is still aspirational.

### 3.3 Trust rotation

**Options (ROT):** A re-enroll-only · B signed monotonic bundles · C overlapping-key epochs · D owner-local pin.

**Non-negotiable invariants**
- Trust data ≠ private-key storage [ROT §1; CON F8].
- Retired/revoked server keys never reactivate [CR-5A; `persistence.ts:249` states].
- Bundle shrink below the ≥1-key floor is forbidden unless owner-step-up [ROT §4.8; `persistence.ts:77`].
- Offline revocation is delivery-bounded [CON F6].

**Dependencies:** transport is a v1-closed frame union (ROT open Q1) — same protocol-version tax as RCPT V3. Clock clamp (STM B-2a) becomes load-bearing if `valid_until` is grafted (ROT R4). Enrollment pin (D-graft) needs the same owner-presence moment as CEIL A.

**Owner decision:** v1 mechanism; frame vs heartbeat transport; fetch interval / `valid_until`; shrink-counter signer; whether to reserve C's per-key epoch fields in the v1 bundle schema.

**Recommended default (not an ADR):** ROT's **B + D-pin-at-enroll + C-`valid_until` graft**. Reject A as routine path (keep as catastrophe fallback). Confidence: **medium** — smallest thing that closes F6 operationally; grafts add clock and bootstrap coupling.

**Rollback story:** epoch monotonicity rejects old bundles. All-keys-lost → Option A re-enroll. Malicious-valid shrink → residual R3 accepted (that *is* T1).

**Exact tests:** ROT §4.9 / §5.9 (epoch oracle, surviving-key signature, all-revoked fail-closed, crash fetch/apply, key-count floor, offline lease-bound, post-`valid_until` rejection without connectivity, clock-manipulation fixtures before v1).

**Independent challenge:** The D-graft "pin at enrollment" does not close the first-enrollment bootstrap gap ROT itself names ("trusts whoever answers") unless the pin arrives *out of band* (printed fingerprint / deploy config), not from the enrollment response. If the pin *is* the enrollment payload, D-graft is theater. Codex should require the pin source to be independent of the server's first message.

### 3.4 Effect admission / ambiguity

**Options (ADM):** J journal claim row · E in-process lock · D destination idempotency.

**Non-negotiable invariants (ADM I1–I6)**
- Delivery dedup ≠ effect idempotency.
- Concurrent duplicate → serialize/refuse, never parallel fire (ATX 9b).
- Pre-effect crash may re-authorize; post-effect/pre-ack → AMBIGUOUS, never silent re-fire (ATX 10).
- Ambiguity settles only with destination evidence or a safe failure code.
- Never claim exactly-once external effects.

**Dependencies:** proposed `BridgeCommandGate` [LIFECYCLE #29] must grow `in-progress` (CON F4). STM pre-effect proof and ADM `effect_claims` are the *same* write — unify or they will drift. RCPT governs what those rows may store. DEST digest identity feeds `operation_digest` / `idempotency_key`.

**Owner decision:** J+D vs alternatives; refuse vs defer on 9b; `ambiguousEffectPolicy` default (`types.ts:89` attention precedent); journal vs sibling store if v2 daemon.

**Recommended default (not an ADR):** **J for admission, D for resolution, E optional in-process.** Confidence: **high** on rejecting E-alone; **medium-high** on J+D.

**Rollback story:** `claimed` without executing-marker → safe re-dispatch. `executing` → AMBIGUOUS unconditionally (no heuristics). No automatic retry out of AMBIGUOUS.

**Exact tests:** ADM §5 (transition unit U9/U10, claim_key collision-stable property, 9b integration, 9c replay, kill-boundary per crash row). No test named "exactly-once".

**Independent challenge:** `claim_key = sha256(nodeId ‖ messageId)` serializes *redelivery of the same message*, not *re-offer of the same effect*. A server that issues a new `messageId` for the same job/attempt after a crash (legal under at-least-once frames) bypasses J and can double-fire. The destination `idempotency_key` is the only backstop — and ADM admits destinations may not honor it. Codex should require admission uniqueness on `(nodeId, jobId, attemptId, operationDigest)` (or the server idempotency key), with `messageId` as a secondary delivery key — or explicitly accept "new message = new claim" as a known hole closed only by D.

### 3.5 Denial receipts *(self-review)*

**Options (RCPT):** vocabulary V1/V2/V3; digest vs stable ID; coalescing + probe-budget flattening; approval attestations E1/E2.

**Non-negotiable invariants**
- No C5–C7 on the wire (policy internals, refused payload, free text / raw OS errors) [ATX 11; #47 acceptance].
- `assertNoSecretMaterial` on every outbound body [`redaction.ts:38–41`].
- Wire enum stays closed in v1 [`types.ts` `OfferDecisionBody.safeReasonCode`].
- Node cannot witness strongFactor; can verify a server-signed attestation [CON F9].

**Dependencies:** V3 and ROT's new bundle frame both want a protocol-version event — batch them or pay twice. STM receipt codes (`authority_expired_*`, `effect_ambiguity_raised`) must fit V2's coarse-on-wire rule. CEIL `ceiling_adopted` is an audit event, not a denial, but uses the same classification table.

**Owner decision:** D-47-A..F (tier, digest+coalesce pair, prefix length, W/N defaults, E1 vs E2, journal chaining).

**Recommended default (not an ADR):** **V2 + digest-normative + coalescing + E2.** Truncation (D-47-C) optional. Confidence: **medium** on V2 (ops blindness is real — see challenge); **high** on rejecting stable ceiling IDs and V3-in-v1.

**Rollback story:** coalescing is local and reversible (disable the window). Vocabulary V2→V1 is a config drop of the detail tier. Prefix length can grow later without invalidating old receipts if the server stored the enrollment full digest.

**Exact tests:** RCPT P-1..P-8.

**Independent challenge (stricter, own work):**
1. Coalescing + probe-budget flattening will hide a *mis-provisioned ceiling* during first rollout — the exact window operators most need visibility. Default W/N should start *off* or very loose until a rehearsal says otherwise; shipping "secure defaults" here fights operability.
2. Do not treat 8-byte `ceilingDigestPrefix` as a privacy control (overstatement table). If D-47-C ships, document it as a join-key compression, or drop it.
3. RCPT recommended V2 because V3 is an oracle; DEST §7 then wants node-local detail codes that "never echo" — good — but STM's richer lifecycle codes (`authority_expired_in_grace`) already leak grace *policy* if they go on the wire. Keep grace on the local tier.

### 3.6 Destinations / network

**Options (DEST):** string form C1/C2/C3; resolve-once pin (R1) vs periodic revalidation (R2) vs DoT/DoH (R3); D-4a specified, D-4b open.

**Non-negotiable invariants**
- Authorization compares canonical forms only [ATX 3/5].
- D-4a (node connect-time pin) proceeds regardless of D-4b [CON F5].
- IP-pin without TLS name verify is not host identity [DEST §5 honesty].
- Redirects never inherit authorization [DEST §6].
- Fail closed on canonicalization failure.

**Dependencies:** C3-as-digest-input is schema-stable only *before* freeze [DEST §3]. OPTS ceiling `networkPolicy` / `networkDestinations` is the local allowlist shape. RCPT forbids echoing the offending destination. Private-range default-deny interacts with desktop nodes (Marvin Aqua / Ziggy interactive) that legitimately hit loopback tools.

**Owner decision:** C3 including digest input; D-4b owner (DEST suggests server-at-authoring); private-range set + exception syntax; R2 schedule.

**Recommended default (not an ADR):** **C3 internally, R1 pin+cert, D-4a now, D-4b = server authoring-time normalize.** Defer R2/R3. Confidence: **high** on D-4a/R1 and rejecting raw-string authorize; **medium** on C3-in-digest (migration of existing stored intents is undesigned); **low** on private-range default-deny as a fleet-wide default.

**Rollback story:** pin is per-effect; a bad pin fails that effect only. C1 (strict literal) remains the safe fallback if C3 digest migration is deferred — worse UX, no schema break.

**Exact tests:** DEST §8 symbolic corpus + stated integration DNS/TLS fixture (not attempted). Add a localhost-allow exception fixture if private-range deny ships.

**Independent challenge:** DEST's "advisory" wording must not be implemented as "deny receipt but continue" (overstatement table). Also: pin+cert is TLS-only; any non-TLS executor (plain HTTP, custom TCP, browser-opaque) does not get the "named host" half of the invariant. Those tools must be ceiling-excluded from `allowlist` (DEST already says this for opaque tools) — extend that exclusion to **all non-TLS** unless Codex accepts IP-pin-only as a weaker class with a distinct receipt code.

---

## 4. Cross-domain incompatibilities (compose or choose)

| Pair | Tension | Compose? |
|---|---|---|
| CEIL A+B × OPTS A+C | Two "hybrids" | Yes — different layers (machine vs lease) |
| CEIL B file-drop × CON F1/D6 | Same unsolved Linux delivery | Decide D6 once; both consume it |
| STM G0 × ADM ambiguity | Hard-stop ⇒ more AMBIGUOUS | Decide together; do not ship G0 without ADM resolution path |
| STM B-2a clock × ROT `valid_until` | Trust becomes clock-sensitive (ROT R4) | Same injected-clock fixture suite is mandatory for both |
| STM renewal arrow × EXPIRED terminal | Resurrection bug | Forbid EXPIRED→EXECUTING |
| ADM `claim_key` × at-least-once new messageId | Double-fire hole | Tighten admission key or accept D-only backstop |
| ADM J "one writer" × LIFECYCLE v2 daemon | 9b re-opens | J requires shared writer; daemon implies different lock |
| RCPT V3 × ROT new frame | Two protocol-version events | Batch or defer V3 |
| RCPT coalescing × first-deploy debug | Ops blindness | Start coalescing off |
| DEST C3-in-digest × existing raw-string digests | Schema/migration | Freeze-blocker; otherwise keep C1 on the wire digest |
| DEST private-range deny × desktop loopback | Breaks local tools | Exception syntax required before default-deny |
| SYN `verifyTrust` × ROT trust store | Interface lie | Drop the method |

---

## 5. Ranked defaults (for Codex, still not an ADR)

| # | Domain | Default to take | Confidence | Blocked on |
|---|---|---|---|---|
| 1 | Destinations D-4a | Specify + implement pin+cert now | high | nothing (CON F5) |
| 2 | Trust store vs keystore | Separate; drop `verifyTrust` | high | nothing (CON F8) |
| 3 | Expiry clock split | B-2a / B-2b | high | D-44-A owner only |
| 4 | Ceiling authority | Reject C | high | — |
| 5 | Effect admission | J + D, not E-alone | high | unify with STM proof row |
| 6 | Receipt identity | No stable ceiling ID | high | — |
| 7 | Ceiling mechanism | A+B hybrid | medium | owner-signed-inside-enrollment; D6 for Linux |
| 8 | Trust rotation v1 | B + out-of-band pin + `valid_until` | medium | pin source; frame transport; clock fixtures |
| 9 | Receipt vocabulary | V2, coalescing **off** at first deploy | medium | D-47-D defaults |
| 10 | Approval locally | E2 verify attestation | medium | INV B-row wording in OPTS |
| 11 | Expiry grace | G0 only if ADM resolution is in the same slice | low-medium | D-44-D + ADM |
| 12 | DEST C3-in-digest | Only if before freeze | medium | migration plan |
| 13 | Private-range default-deny | Do not fleet-default on | low | exception syntax |
| 14 | Offline revocation immediacy | **Never claim it** | high (honesty) | — |

---

## 6. Acceptance self-checks

- Six primary PRs existed before drafting; none declared missing ✔
- One independent challenge per domain, including stricter challenges on self-authored STM/RCPT ✔
- Conflict table + overstatement table with restatements ✔
- Options, invariants, dependencies, owner decision, recommended default + confidence, rollback, exact tests — all six domains ✔
- No ADR, no code, single allowed path ✔
- `git diff --check` clean at commit time ✔

## Stop boundary

Read-only synthesis. Allowed path = this file. No source/tests/migrations/config. No merge. Unmerged dossier text cited by PR SHA, not treated as `main`.

## Method note

Read CEIL/ROT/ADM/DEST in full from PR refs; STM/RCPT in full (self-authored, re-challenged). Merged CON/TRACE/OPTS/ATX/THM/SYN/INV/OPS consulted for conflicts. Source pins re-checked at `049bf80`: `persistence.ts:76–84,207,249`; `state-machines.ts:75–82`; `redaction.ts:38–41`. Absolutes grepped against the six dossiers before use; remaining `[inference]` items are DEST/ROT's own markers, carried forward, not upgraded.
