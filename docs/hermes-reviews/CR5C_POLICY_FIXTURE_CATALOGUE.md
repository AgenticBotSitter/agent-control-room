# CR-5C policy fixture catalogue and property-test plan

**Status:** Complete 2026-08-23
**Worker route:** Johnny5 / Debian 13 VPS / Hermes Agent — QA-design documentation packet; medium risk; report-only.
**Repo state analyzed:** `main` @ `489cd6d`; adversarial matrix (issue #15 branch), enforcement inventory (#14), node-local threat model (#16).
**Purpose:** Convert the merged adversarial matrix into a compact, reusable fixture catalogue and property-test plan for the eventual CR-5C implementation. **No tests are written** — the contract is not final. Every fixture is symbolic, deterministic, secret-free, and platform-neutral.
**Sources:** `docs/hermes-reviews/CR5C_ADVERSARIAL_TEST_MATRIX.md` (matrix), `CR5C_AUTHORITY_EFFECT_ENFORCEMENT_INVENTORY.md` (inventory), `CR5C_NODE_LOCAL_THREAT_MODEL.md` (threat model), existing test style under `tests/**`.

## 0. Reading guide

- **Fixture** = a named symbolic input shape with generators, shrink constraints, and an oracle. Fixtures are *descriptions of shapes*, never concrete production values — no real IDs, hosts, keys, paths, or tenant names appear anywhere.
- Each fixture maps to matrix case(s) and to the current source seam it will exercise once CR-5C builds it.
- Property style follows the repo's `node:test` + `node:assert/strict` conventions (`tests/security.test.ts:1-13`); no property-based library is currently in dependencies, so the plan assumes either hand-rolled seeded generators or an explicitly added dependency decision (flagged, not made).

## 1. Fixture catalogue

### F1. Authority envelope + local ceiling pair
| Aspect | Specification |
|---|---|
| Shape | `{ ceiling: C, envelope: E }` where both carry `operations[]`, `maxDurationSeconds`, `networkAllowlist[]`, `maxCostUsd`, `validFrom`, `expiresAt`, `projectId`, `parentDigest?` (mirrors `AuthorityEnvelope`, `src/domain/v1/types.ts:47-60`) |
| Generators | Valid subset relation E ⊆ C; each dimension independently violated (wider op set, longer duration, extra destination, higher cost, expired window, future validFrom); child-of-child chains of depth ≤3 |
| Shrink | Toward empty allowlist / zero duration / minimal op set; violation dimension collapses to equality |
| Oracle | Accept iff every E dimension ⊆ C and window contains local now (matrix cases 1, 2a, 2b, 7) |
| Forbidden | Real project/tenant IDs; digests computed over non-canonical serializations |
| Maps to | Matrix §1, §2a/b, §7; inventory A1–A3 |

### F2. Command frame corpus
| Aspect | Specification |
|---|---|
| Shape | Signed server_to_node command frames (`job.offer`, `job.lease.grant`, `job.lease.renewed`, `job.cancel`) with symbolic bodies; plus malformed variants (wrong direction/type, oversized, bad digest) |
| Generators | Valid frames under F1 pairs; body-digest mismatch; unknown operation names; argument-digest alteration (matrix case 4); replay twins (same messageId/nonce, altered byte anywhere) |
| Shrink | Toward minimal valid frame; single-field mutation from the valid twin |
| Oracle | Gate accepts only frames that pass protocol auth AND F1; altered-reuse always replay-conflict (`journal.ts:190-219`) |
| Forbidden | Any key material — signatures use per-test throwaway Ed25519 pairs (pattern already used at `tests/node-bridge.test.ts`) |
| Maps to | Matrix §1, §4, §9; inventory E1–E7 |

### F3. Path/target corpus
| Aspect | Specification |
|---|---|
| Shape | Symbolic scratch-root R + requested target strings |
| Generators | Canonical inside-root paths; `..` traversal; symlink-escape descriptors; non-canonical spellings (`//`, trailing `/`, percent-encoding, Unicode confusables); absolute-vs-relative mixes; root itself |
| Shrink | Toward the shortest escaping variant (`..`) |
| Oracle | Canonicalize-then-compare; any escape or canonicalization failure ⇒ deny `target_outside_scope`; lexical match alone never accepts (matrix case 3) |
| Forbidden | Real filesystem paths — roots are symbolic (`/scratch/<symbolic-node>`) |
| Maps to | Matrix §3; inventory A4 analog |

### F4. Network destination corpus
| Aspect | Specification |
|---|---|
| Shape | Allowlist entry `{host, port, scheme}` + request variants incl. resolution-sequence descriptors |
| Generators | Exact matches; scheme downgrade; port drift; IP-literal-for-hostname; IPv6 bracket forms; rebinding sequences [allowed-IP → attacker-IP]; resolver-failure |
| Shrink | Single-field deviation from the exact-match base |
| Oracle | Scheme/port exact; connect-time identity pinned to first resolution or deny `network_destination_violation` (matrix case 5) |
| Forbidden | Real hostnames/IPs — all `.test` reserved-zone symbolic names and documentation-range IPs only |
| Maps to | Matrix §5; threat model T7; inventory A4 |

### F5. Approval evidence record
| Aspect | Specification |
|---|---|
| Shape | `{ approvalDigest?, risk?, expiresAt?, strongFactorEvidence? }` as the node would receive it |
| Generators | Present+matching; absent; expired; risk-mismatched; digest-mismatched vs effect operation digest (`computeEffectOperationDigest`, `src/security/digest.ts:67+`); strong-factor present-but-stale |
| Shrink | Toward fully-absent evidence (must still fail closed, not crash) |
| Oracle | Effect requiring approval proceeds only on matching unexpired evidence; absence ⇒ deny receipt, never silent pass (matrix case 11; inventory B1–B3) |
| Maps to | Inventory B-family; matrix §11 |

### F6. Trust-state fixture (key store + trust bundle)
| Aspect | Specification |
|---|---|
| Shape | `{ bundleVersion, keys[{keyId,state,principalState,validFrom,validUntil}] }` + node keystore availability states `"available"\|"locked"\|"missing"\|"corrupt"` (per synthesis report vocabulary) |
| Generators | Active keys; quarantined; revoked-with-cached-v1-copy; empty bundle after failed rotation; validity-window edges (±1 ms around bounds, mirroring `authentication.ts:100-106`) |
| Shrink | Toward empty bundle |
| Oracle | Revocation beats cache offline; absence of verifiable trust fails closed to `backing_off`, zero execution (matrix case 8) |
| Forbidden | No real key material — generated test keys only |
| Maps to | Matrix §8; threat model T8; probe reports #11–#13 |

### F7. Time source
| Aspect | Specification |
|---|---|
| Shape | Injectable clock: `() => ISO string`, plus frame timestamps |
| Generators | now ∈ {before validFrom, inside window, after expiresAt, ±skew boundaries}; monotonic vs jumping clocks; NaN/garbage strings |
| Shrink | Boundary values first (T±ε) |
| Oracle | Node-local clamp uses injected clock only — no ambient `Date.now()` in gate code (deterministic-test requirement consistent with bridge's injected `now` design, `bridge.ts:79,115`) |
| Maps to | Matrix §2a/2b |

### F8. Expected safe receipt (denial/ambiguity oracle)
| Aspect | Specification |
|---|---|
| Shape | Receipt `{messageRef, safeReasonCode, ceilingId, timestamp}`; ambiguity states from `state-machines.ts:75-82` |
| Generators | One receipt per denial path in F1–F6; fuzz payloads shaped like secrets (canary tokens) injected into refused-command arguments |
| Shrink | Minimal receipt = ref+code only |
| Oracle | Receipt ∩ (refused payload ∪ local config) = ∅; codes drawn only from the closed safe-code vocabulary; receipts pass `assertNoSecretMaterial` (`redaction.ts:38-41`) — this is the acceptance spec for receipts that don't exist yet (inventory G2) |
| Forbidden | Echoing refused arguments, allowlist contents, internal paths, key IDs of *local* keys |
| Maps to | Matrix §11, §10c; inventory G2 |

## 2. Property-test plan

Each property lists generator source, shrink constraint, oracle, and forbidden outputs. Seeded determinism is mandatory: every generator takes a seed; CI runs fixed seeds; local exploration may vary them.

| P# | Property | Gen | Oracle (never breaks) | Class |
|---|---|---|---|---|
| P1 | Envelope⊆ceiling acceptance | F1 | accept iff all dims ⊆ ∧ window valid; any single widening denied | property |
| P2 | Signed-frame cannot widen ceiling | F1×F2 | signature validity is irrelevant to ceiling denial | unit→kill-boundary |
| P3 | Local-clock expiry clamp | F1×F7 | refuse past local expiresAt regardless of server clock | unit |
| P4 | Path safety | F3 | canonical compare only; traversal/symlink/non-canonical all denied | property |
| P5 | Destination pinning | F4 | connected identity == allowed entry, else denied | property+integration |
| P6 | Budget conservation | F1 arithmetic fuzz | Σ charged spend ≤ ceiling under any interleaving; integer minor-units only; non-finite/negative fail closed | property |
| P7 | Child-narrowing | F1 chains | delegation chain can only narrow, every boundary | property |
| P8 | Replay/effect idempotency split | F2 | delivery dedup holds even when effect dedup fails, and vice versa (matrix 9a–9c) | integration |
| P9 | Crash-window honesty | matrix 10a–10c seeds | pre-effect re-auth safe; post-effect ⇒ ambiguous, never silent re-fire; ambiguous resolves only on receipt evidence | kill-boundary (CR-5Q rig); unit seeds now |
| P10 | Receipt hygiene | F8 fuzz | no denial receipt ever contains secret-shaped or capability data | property |
| P11 | Operator pause supremacy | pause sentinel ×F2 | pause halts accepts immediately; works offline (matrix 12) | manual-platform+integration |
| P12 | Trust revocation beats cache | F6 | revoked ⇒ no execution without connectivity | unit |

## 3. Mapping to current tests

| Existing suite | What it already covers | What CR-5C fixtures add |
|---|---|---|
| `tests/node-protocol.test.ts` | frame auth, expiry/skew (matrix 2a notes :283 family), replay primitives | nothing duplicated — F2 references these as preconditions |
| `tests/node-bridge.test.ts` | queueing, duplicates, crash-retry (:329), backpressure, reconnect | gate fixtures (P1/P2/P10) attach at the new seam; retry semantics unchanged |
| `tests/security.test.ts` | policy evaluation, approvals, digests, redaction centrally | node-side mirrors (F5) reuse its record shapes symbolically |
| `tests/canonical-persistence.test.ts` | delivery dedup, ack-loss loop, poison parking, pre-effect crash (:250-390) | effect-boundary cases 9b/9c/10b/10c are new, not rewrites |

No existing test needs modification; all new fixtures land behind the CR-5C implementation when contracts finalize.

## 4. Deferred to later blocks (do not fake now)

- **Real PostgreSQL concurrency** (cases 6/9b true interleaving): blocked by PGlite single-connection tests — waits for CR-4Q-style rehearsal environment. Until then P6/P8 run single-threaded with serialized schedules only.
- **Kill-boundary automation** (case 10): needs the CR-5Q crash-injection rig; we commit only the unit seeds (P9 "unit seeds now").
- **Platform keystore behaviors** (F6 native modes): waits for CR-5C key-store interface built on probes #11–#13; fixtures stay mode-symbolic until then.
- **Live DNS/socket rebinding** (case 5 end-to-end): needs CR-6A local-resolver environment; P5 stays at descriptor level.
- **Property-generation library choice**: adding `fast-check` (or hand-rolled seeded generators) is an explicit dependency decision — flagged for the implementer/Codex review, not assumed here.

## 5. Secret-free and platform-neutral guarantees

- All hosts use the reserved `.test` TLD; IPs use documentation ranges; all identifiers are `tenant:example`, `node:symbolic`, `op.render`-style names; all keys are generated per-run.
- No fixture reads environment, filesystem outside the test's temp dir, network, or wall clock directly (time comes from F7 injection).
- Determinism: same seed ⇒ same corpus; shrinks are pure functions.

## Stop boundary

Documentation only. No test/source/migration/dependency edits, no live data, no merge. Allowed path touched: this file only.
