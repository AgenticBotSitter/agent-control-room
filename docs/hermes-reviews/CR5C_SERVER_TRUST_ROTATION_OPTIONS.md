# CR-5C server-trust rotation and revocation protocol options

**Status:** Complete 2026-08-23
**Worker route:** Johnny5 — Hermes Agent (`stealth/ox-alpha` via Nous), Debian VPS container
**Task class:** doc-only protocol options analysis (issue #45; closes contradiction-review F6)
**Repo state:** `main` @ `049bf80` ("Merge pull request #42"), branch `worker/johnny5/45-server-trust-rotation`
**Purpose:** Compare four candidate mechanisms for trusted server-key-bundle distribution, rotation, rollback protection, expiry, and offline guarantees. Non-binding: this document recommends, Codex/Sol decides. No CR-5A schemas are modified.
**Stop boundary:** Doc-only. No code, schema, config, or key material created; no network calls made beyond authenticated GitHub API/git transport for claim/PR mechanics; no live integration exercised.

## 1. Problem statement (from F6 and its sources)

Today a node receives the complete set of Ed25519 server trust keys exactly once, inside its enrollment response (`src/node-protocol/v1/persistence.ts:207`, advertised at enrollment-challenge creation `persistence.ts:76-84`). There is no refresh path. Consequences, per prior reports:

- **INV E8 / THM residual 2:** compromise of a server signing key is unrecoverable except by full re-enrollment of every node.
- **TRACE F-6:** rotation mechanism "decision-required"; must precede first real deployment (SYN D5).
- **ATX case 8(b)** asserts "revocation beats cached trust without requiring connectivity" — impossible as written, because bundle v2 cannot reach an offline node. Contradiction-review F6 restates this honestly: revocation wins *once delivered*; offline, the guarantee degrades to lease-expiry bounding (THM T8).

This dossier treats that restatement as the honest baseline and evaluates mechanisms against it.

### Trust-data vs key-storage distinction (acceptance requirement)

Everything below concerns **public-key trust data**: SPKI-encoded Ed25519 public keys, key IDs, fingerprints, validity intervals, and state — data whose disclosure is harmless and whose integrity is what matters. It must never be conflated with:

| | Public-key trust store | Private-key storage |
|---|---|---|
| Contents | server public keys + metadata (the "bundle") | node identity key; server holds none |
| Integrity need | authenticated (signature on updates) | confidentiality + hardware/OS protection |
| Natural home | plain file / SQLite row, world-readable | platform keystore (`NodeKeyStore`: Keychain / DPAPI / encrypted-file per SYN §3) |
| Rotation concern | distribution + anti-rollback | separate problem (node key rotation is CR-5A re-enrollment territory) |

Corollary adopted throughout: **trust-store writes are not keystore operations**, and vice versa. This also implements contradiction-review F8's correction: trust resolution belongs to app logic beside `TrustedProtocolKey` lookup (`persistence.ts:248-261`), not to `NodeKeyStore`.

Current state in source: the node-side verifier consumes whatever keys were returned at enrollment; the DB resolver (`TrustedProtocolKey` rows with `active/retired/revoked` states, `valid_from`/`valid_until` — `persistence.ts:221,252`) is server-side only. The bridge has no bundle format yet — which is why this decision is cheap now and expensive later.

## 2. Common evaluation frame

Each option is scored on the nine dimensions required by the issue:

1. **Bootstrap trust** — how does a fresh node first learn whom to believe?
2. **Signer/key compromise** — what happens when a server trust key goes bad?
3. **Anti-rollback** — can an attacker feed the node an old-but-valid bundle to resurrect a revoked key?
4. **Revocation propagation maximum** — worst-case time from server-side revoke to all connected nodes refusing the key (offline nodes excluded).
5. **Offline execution bound** — what does a disconnected node still honor, and what bounds it?
6. **Storage responsibility** — trust store vs key store ownership.
7. **Replay interaction** — interplay with durable nonce/sequence replay windows and journal.
8. **Recovery path** — how does the fleet get healthy again after a bad key?
9. **Test plan** — symbolic fixtures consistent with the policy fixture catalogue (P-series, PR #40 lineage).

Shared assumptions: Ed25519 only (v1 constraint, `persistence.ts:80`); canonical-frame signature discipline unchanged; nodes may be offline arbitrarily long (THM T8); the server DB already models key state transitions irreversibly (retired cannot reactivate, revoked cannot restore — CR-5A doc "Enrollment" §6).

## 3. Option A — Re-enrollment only (status quo formalized)

Rotation *is* full re-enrollment: owner revokes the compromised key server-side, issues new enrollment tokens to every node, each node re-proves possession of its node identity key and receives the new trust set.

1. **Bootstrap:** existing path — enrollment response carries initial grant digest + trust keys (`persistence.ts:199-207`). No change.
2. **Signer compromise:** recoverable but O(fleet): every node needs an operator-driven re-enrollment. While nodes still hold the compromised key as trusted, frames signed by it verify — so revocation of *server* keys has no node-side effect at all until re-enrollment completes. Worst case is unbounded (operator-paced).
3. **Anti-rollback:** trivially safe — there is nothing to roll back; trust changes only through the enrollment transaction.
4. **Revocation propagation maximum:** effectively infinite for server-key revocation (until each node re-enrolls); immediate for node-key revocation (existing authenticator check, `authentication.ts:102`).
5. **Offline execution bound:** an offline node keeps honoring the compromised server key indefinitely; only lease expiry (`canonical-store.ts:294-297`) bounds individual grants. Honest bound: **lease lifetime**, same as today.
6. **Storage:** trust data lands in whatever the bridge persists post-enrollment; no new store.
7. **Replay:** untouched; enrollment consumes token+challenge transactionally, replay windows unaffected.
8. **Recovery:** guaranteed convergent (every node ends up correct) but slow, manual, and fleet-wide — and it burns the enrollment-token/challenge machinery for what should be routine operations, increasing exposure of the 15-minute token path.
9. **Test plan:** P-series fixtures suffice (enrollment oracle exists). Add one kill-boundary rehearsal: revoke server key → confirm connected nodes still accept its signatures (documenting the gap) → re-enroll → confirm refusal.

**Verdict:** safe, honest, operationally terrible at scale, and it makes ATX 8b permanently untestable. Viable only as the fallback when every distribution mechanism fails.

## 4. Option B — Signed bundle updates

The server periodically publishes a monotonic trust bundle — `{epoch, keys[], minEpoch, notAfter?, signature}` — signed by a currently-trusted server key. Nodes fetch it opportunistically over the existing protocol (new frame type or heartbeat attachment); the bridge verifies the signature against its current bundle before applying.

1. **Bootstrap:** unchanged — enrollment response delivers bundle v1 (the current `serverTrustKeys` payload generalizes into the bundle envelope).
2. **Signer compromise:** publish vN+1 removing the bad key, signed by any surviving trusted key. Connected nodes converge within one fetch interval. If ALL trusted keys are compromised simultaneously, fall back to Option A (re-enrollment) — B strictly reduces its scope to catastrophic cases.
3. **Anti-rollback:** epoch monotonicity enforced locally: reject any bundle with `epoch <= current.epoch`; carry `minEpoch` so a node refuses bundles older than the newest it ever accepted, even after local state loss. Residual: a full-wipe attacker who also controls the update channel can replay the highest epoch they ever saw minus nothing — bounded by the fact they'd need a validly-signed old bundle, i.e., they hold a since-revoked key AND the node never saw a newer epoch. Documented residual risk, see §7.
4. **Revocation propagation maximum:** fetch-interval bound for connected nodes (configurable; propose ≤15 min default). Offline nodes: until reconnect — no mechanism can beat this (F6's core honesty point).
5. **Offline execution bound:** node keeps last-known-good bundle indefinitely; bound remains lease expiry. Optional hardening: bundle `notAfter` forces re-fetch-or-backoff after N days, converting "indefinitely" into a configurable staleness ceiling at the cost of availability.
6. **Storage:** bundle lives in plain trust-store persistence (SQLite column or file next to the journal), NOT the keystore; only its verification uses keys already inside the bundle chain rooted at enrollment.
7. **Replay interaction:** bundle application must be journaled (append-only epoch record) so a crash between fetch and apply resumes correctly; frame-level replay windows untouched since bundles ride authenticated connections. An exact-duplicate bundle delivery is idempotent (same epoch ⇒ no-op).
8. **Recovery:** single bad key = one publish; all-keys-lost = Option A fallback. Bridge-side failure mode "applied a bundle that locks out the real server" is mitigated by never letting a bundle drop the key count below the enrollment invariant floor (>0; mirror `persistence.ts:77`) and by requiring every new bundle keep ≥1 key from the previous epoch unless countersigned by the owner factor (step-up approval per CR-3 R3).
9. **Test plan:** symbolic fixtures: epoch monotonic oracle (reject older/equal), signature-by-surviving-key acceptance, all-keys-revoked fail-closed, crash-between-fetch-and-apply resume, key-count-floor rejection, offline-node lease-bound assertion (ATX 8b restated precondition).

**Verdict:** smallest mechanism that actually closes F6's operational gap. Recommended v1 — see §7.

## 5. Option C — Overlapping-key epochs

Formalize key generations: each rotation introduces a NEW key ID alongside the old (CR-5A already mandates distinct-key-ID insertion, never in-place replacement); the bundle carries both during a overlap window; nodes trust the union of non-expired epochs. Old keys get `valid_until` and expire automatically.

1. **Bootstrap:** enrollment delivers the currently-overlapping set (generalization of the 1–8 key array, `persistence.ts:77`).
2. **Signer compromise:** add replacement key, mark compromised key revoked (immediate, propagates via whichever distribution channel — C composes with B rather than replacing it).
3. **Anti-rollback:** stronger than B alone: because old keys carry explicit `valid_until`, a replayed ancient bundle advertises keys that are expired-by-time even if the node never saw the revocation. Time becomes a second, connectivity-free kill switch.
4. **Revocation propagation maximum:** hard bound = min(fetch interval, remaining overlap window). This is the only option that gives an *offline* revocation guarantee with a computable deadline.
5. **Offline execution bound:** leases bound execution; expired-epoch keys bound trust. Both clocks run without connectivity — materially better than A/B where the only offline bound is lease expiry.
6. **Storage:** same plain trust store; adds per-key epoch metadata.
7. **Replay:** none new; overlapping keys coexist in the resolver naturally (multiple active rows already supported by the 1–8 array).
8. **Recovery:** automatic expiry retires stale keys even if the operator forgets; emergency path remains revoke-and-redistribute.
9. **Test plan:** overlap-window fixtures: dual-active verification, post-`valid_until` rejection without connectivity (the offline-revocation property ATX 8b wanted), overlap exhaustion forcing re-enrollment, epoch arithmetic edge cases.

**Verdict:** best offline properties, but adds time-synchronization sensitivity (node clock clamp from matrix case 2a becomes load-bearing for trust decisions, not just lease checks) and more state. Right as a **v2 layer on top of B**.

## 6. Option D — Owner-local trust-anchor updates

The human owner holds an out-of-band anchor (e.g., a printed/fingerprint-pinned root key or a manually distributed pin list). Trust changes require explicit owner action at each node (paste a pin, approve a fingerprint prompt).

1. **Bootstrap:** owner installs the anchor out-of-band; enrollment verifies against it instead of trusting the server's self-advertised set — fixes the "first enrollment trusts whoever answers" bootstrapping gap none of A–C addresses.
2. **Signer compromise:** owner pins the replacement at each node; strongest assurance, fully manual.
3. **Anti-rollback:** strongest possible — anchors don't rotate without a human.
4. **Revocation propagation maximum:** operator-paced; hours-to-days for a fleet of one, unbounded for a fleet of many.
5. **Offline execution bound:** anchored keys persist until owner acts; combined with lease expiry.
6. **Storage:** anchor in protected local storage (keystore-adjacent — it is small, secret-like in value though public in nature); bundle below it stays in the plain trust store.
7. **Replay:** none new.
8. **Recovery:** always available (owner is the root of trust) but doesn't scale.
9. **Test plan:** pin-mismatch fail-closed, anchor-survives-failed-update, owner-factor step-up integration per CR-3 R3 approval records.

**Verdict:** excellent as a *bootstrap hardening* (pin the enrollment-time key set) and as the break-glass root; unusable as the routine rotation channel.

## 7. Recommendation (non-binding)

**Smallest safe v1 = Option B (signed bundle updates), with two pieces of D and one of C grafted in:**

1. **B as the distribution channel** — new monotonic signed bundle, fetched over the existing authenticated connection, applied transactionally with journal record; fails closed on any verification error; preserves the ≥1-key floor and the counter-signed-shrink rule.
2. **From D:** at enrollment, the owner/operator pins (or the deployment config pre-records) the fingerprint of the initial bundle, closing the bootstrap-trust gap cheaply.
3. **From C:** every new bundle key gets a `valid_until` (generous, e.g. 90 days default, renewable by publication), so time eventually retires anything the update channel can't reach — giving offline nodes a computable second bound alongside lease expiry.

Explicitly recorded residual risks:

- **R1 (offline window):** no mechanism delivers revocation to a disconnected node. Until reconnection, a compromised server key remains trusted there; execution is bounded only by lease expiry plus (with graft 3) key `valid_until`. ATX case 8b must be restated per F6: "revocation wins once bundle vN is delivered."
- **R2 (highest-epoch replay):** an attacker holding both the update channel and a since-revoked signing key can replay the newest bundle the node ever received, at most. Mitigated by owner-pin (graft 1) and short `valid_until` (graft 3); eliminated only by D-grade manual anchoring.
- **R3 (lock-out):** a malicious-but-valid bundle could evict the legitimate server's keys. Mitigated by the shrink-counter signature rule; residual accepted because the equivalent threat (compromised server) is the scenario being defended against.
- **R4 (clock dependence):** graft 3 makes node-clock clamping (matrix 2a) load-bearing for trust, not just leases. Clock-manipulation fixtures become mandatory before v1 ships.

What needs a real integration environment (out of scope here, symbolic fixtures only): actual bundle fetch/retry behavior under flaky links; timing of propagation vs fetch intervals in production topology; rehearsal of rotate-during-job (TRACE F-6's kill-boundary test) on the CR-5Q rig.

## 8. Open questions for Codex/Sol

1. Bundle transport: dedicated frame type vs heartbeat-attached extension? (Frame union is closed in v1 — adding a type is a protocol-version event.)
2. Default fetch interval and `valid_until` values (proposed 15 min / 90 days above — arbitrary pending ops input).
3. Whether the shrink-counter rule should require the CR-3 step-up owner factor specifically, or any surviving-key countersignature plus audit alarm.
4. Should Option C's full overlap machinery be scheduled as v2 now (affects whether v1 bundle schema reserves epoch fields for keys), or left undecided?

## Method note

Sources read in full or in targeted part on this branch @ `049bf80`: `docs/CR5A_NODE_PROTOCOL_AND_IDENTITY.md` (91L), `docs/CR3_SECURITY_AND_TRUST.md` (revocation/R3 sections), `docs/hermes-reviews/CR5C_RESEARCH_CONTRADICTION_REVIEW.md` (F6/F8, lines 47–70), `CR5C_NODE_LOCAL_THREAT_MODEL.md` (T7/T8, residuals), `CR5C_CROSS_PLATFORM_KEYSTORE_SYNTHESIS.md` (§3–4), `CR5C_ADVERSARIAL_TEST_MATRIX.md` (cases 8, 12), `CR5C_IMPLEMENTATION_REQUIREMENTS_TRACE.md` (F-6, G-2), `CR5C_AUTHORITY_EFFECT_ENFORCEMENT_INVENTORY.md` (E8/G4/A4/D2); source files `src/node-protocol/v1/persistence.ts` (enrollment trust-key flow, lines 51, 76–84, 130, 207, 221, 248–261), `src/node-protocol/v1/authentication.ts` (line 102 key-state gate), `src/persistence/canonical-store.ts` (lease expiry, lines 294–297). All line refs pinned to commit `049bf80`. No absolutes asserted about runtime behavior not verified in the sources above; `[inference]` items: the proposed default intervals (§7.2) and the R2 attack-bound analysis, both labeled as such.
