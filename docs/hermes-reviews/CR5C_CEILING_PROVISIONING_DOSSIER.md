# CR-5C ceiling provisioning and integrity decision dossier

**Status:** Complete 2026-08-23
**Worker route:** Marvin / macOS Mac mini / Hermes (ox-alpha, high reasoning) — documentation-only design analysis; high-risk.
**Purpose:** Decision dossier resolving the evidence Codex needs to choose how a node-local authority ceiling is provisioned, integrity-protected, versioned, rotated, and recovered. Proposes four candidate mechanisms with full comparison; selects nothing, writes no code, makes no ADR.
**Repo state:** current `main` post-#33 merge.

**Citation aliases:** TRACE=#27 trace matrix · DOSSIER=#38 pause dossier · OPTS=#28 local policy contract options · SYN=#26 keystore synthesis · INV=#20 enforcement inventory · ATX=#21 adversarial matrix · THM=#22 threat model · CON=#33 contradiction review · LIFECYCLE=#29 bridge-executor boundary analysis. `[P]`=**proposed in this dossier**, everything else cites existing reports/source.

## 0. The problem

ADR-009 (`CR3_DECISION_LOG.md:106-116`) requires nodes to enforce immutable maximum authority locally so a compromised Control Room server cannot widen it. The gap: **nothing specifies how the ceiling gets onto the node or stays honest once there.** OPTS flagged this exactly: "Ceiling provisioning path is new (who writes `NodeLocalCeiling`, and how its digest reaches Control Room for audit) — unresolved decision" (OPTS §Open questions #2). CON F1 adds the warning that any provisioning story leaning on per-boot secret delivery is decision-required before deployment, not "ready." THM T1/T3 assume the ceiling resists a fully compromised server plus local attacker; TRACE A-2 assumes the node can verify an envelope against it. All of that rests on the mechanism chosen here.

The attack model every option must survive: **attacker = compromised Control Room server key (T1) + same-UID local process (T6) + optionally the node's own worker identity (T2)** — but *not* the owner's enrollment-session presence or (for some options) the platform keystore.

---

## 1. Candidate mechanisms

### Option A — Enrollment-time provisioning (ceiling bound at enrollment, stored in the node trust/identity record)

The owner's enrollment session (the one moment a human with strong factor is provably present, per CR-5A enrollment flow `persistence.ts:73+` NodeEnrollmentStore) carries the ceiling alongside the node identity. The signed enrollment completion records `{nodeId, ceiling, ceilingVersion, issuedAt}`; the node stores it locally; Control Room mirrors the digest for audit.

| Dimension | Assessment |
|---|---|
| Attacker model | Survives T1 **conditionally**: the server never participates in ceiling issuance, only witnesses the digest, and a same-UID attacker can read but not forge (integrity via §2). This survival is NOT unconditional — it holds only if (a) the ceiling bytes are **owner-signed within enrollment** and (b) the trust anchor / provisioning-key pin reaches the node **out-of-band** (never relayed by the server). If either condition fails — e.g. the pin itself is delivered over a channel the compromised server controls — T1 containment is not guaranteed: the attacker who controls pin delivery can substitute their own key and re-sign an arbitrary ceiling. |
| Offline behavior | Perfect — ceiling is local from day one; no server contact needed to know what the machine may do. |
| Tamper detection | Local copy integrity-protected by §2 mechanisms; mismatch vs enrolled digest ⇒ refuse start (fail closed). |
| Rollback/downgrade | Version monotonicity enforced by comparing against the enrollment record's version; §2 protects the local version field. Downgrade attempt = tamper. |
| Ceiling versioning | Rotation requires re-enrollment ceremony (or Option B for lighter rotation). Coarse but maximally strong. |
| Recovery/re-enrollment | Natural: new enrollment = new ceiling. Lost node re-enrolls under owner control. |
| Server audit linkage | Digest mirrored at enrollment; later versions need a re-witness event (see §4). |
| Asymmetric compatibility | Strongest: ceiling is signed by the same owner factor that signs enrollment — one trust anchor. |

**Cost:** rotation friction (full ceremony per change); wrong-ceiling mistakes are expensive to fix.

### Option B — Owner-signed local configuration file (owner signs ceiling updates offline; node verifies against owner public key)

The ceiling lives as a config file `<state-dir>/ceiling.json` carrying an Ed25519 signature by a dedicated **owner/provisioning key** whose public half was pinned during enrollment. Updates = owner signs new version on their own machine, drops file onto node, node verifies + adopts if version > current.

| Dimension | Assessment |
|---|---|
| Attacker model | Survives T1 and T2 **conditionally** (worker key ≠ provisioning key; same conditions as Option A apply — owner-signed bytes + out-of-band pin). Same-UID attacker without the provisioning private key cannot produce a valid update; without §2 protection they could delete/revert — handled below. |
| Offline behavior | Perfect — verification is purely local signature check. |
| Tamper detection | Signature over canonical serialization (reuse `sha256Digest` sorted-key JSON pattern, OPTS §canonical note citing `policy.ts:89`). Bad signature ⇒ refuse, keep last-good. |
| Rollback/downgrade | Monotonic `ceilingVersion` checked against durable high-water mark (§2). Re-presenting v3 after v4 fails. |
| Versioning | Best of the four: incremental, owner-paced, no enrollment ceremony. |
| Recovery | Re-provision by signing anew; if provisioning key lost → fallback to full re-enrollment (Option A path as recovery of last resort). |
| Audit linkage | Each adopted version emits an audit event; digests reconciled server-side eventually. |
| Asymmetric compatibility | Strong — introduces one extra key (provisioning key) which must be *separately protected* per the ADR-009 separation principle and the operator-factor pattern already argued in DOSSIER §2 M-A. |

**Cost:** key management for the provisioning key; physical file delivery to node (trivial for Marvin/Ziggy hosts, needs a defined channel for Johnny5's container).

### Option C — Server-signed artifact (Control Room signs ceilings; node verifies against pinned server key)

Server publishes ceiling artifacts signed with its dispatch key; node pins the server public key at enrollment and verifies updates.

| Dimension | Assessment |
|---|---|
| Attacker model | **Fails the primary requirement.** A compromised server key (T1 — the exact adversary ADR-009 names) can sign a widened ceiling. Verification reduces to "the thing we fear most says so." |
| Mitigations that don't save it | Counter-signing by owner reintroduces Option B; requiring online owner approval at update time converts it into a worse Option B with a server dependency. |
| Offline behavior | Fine technically, meaningless given the trust failure. |
| Verdict | Include in the comparison because it is operationally tempting (no extra keys, easy rotation) — and should be rejected **as sole mechanism**. It may serve as the *transport* inside Options B/A (server relays owner-signed blobs) provided signature verification never trusts server signatures for authorization semantics. This nuance matters: relay ≠ authority. |

### Option D — Platform-bound configuration (ceiling enforced by OS-level mechanism: managed preferences, group policy, container labels)

Encode the ceiling in a platform control plane (macOS managed preferences/profiles, Windows registry policy keys, Docker/container config on the VPS).

| Dimension | Assessment |
|---|---|
| Attacker model | Strong against T2/T6 (same-UID often can't write MDM-managed prefs or root-owned container config), immune to T1 entirely. But strength varies wildly per platform and depends on privilege posture the probes documented as uneven: MAC has SIP/full-security boot [MAC §1], WIN host-dependent, LNX container has reduced caps but root-in-container [LNX §1]. |
| Offline behavior | Perfect. |
| Tamper detection | Delegated to OS integrity mechanisms — good where they exist (macOS), weaker elsewhere. |
| Versioning/rollback | Platform-specific tooling; no uniform story across the three-node fleet. |
| Portability | Worst: three different implementations, three failure models, and the fleet's heterogeneity (Aqua session quirks [MAC §5], DPAPI profile-binding [WIN §4], no-systemd container [LNX §1]) means every platform gate (acceptance-plan P-row family) multiplies. |
| Verdict | Valuable as **defense-in-depth layer** atop A or B (e.g., file-location permissions), not as the portable primary. Also the only option that can constrain the node process *below* its own UID — worth noting for the T6-residual honesty CON F7 demands. |

---

## 2. Integrity protection of local durable state (applies to whichever option stores state locally)

Minimum local state: `{ceiling, ceilingVersion, provisionedAt, provisioningKeyId, lastGoodDigest, versionHighWaterMark}` stored adjacent to the keystore state (SYN §1 reference paths).

- **Integrity:** HMAC or digest chain anchored in the keystore (Option B's provisioning-key signature covers this directly for B; for A, store an enrollment-time MAC keyed by a keystore-held random value so same-UID tampering with the file is detectable even without network). Plain files are insufficient — LNX probe showed permission-drift is routine [LNX §4].
- **Rollback defense:** `versionHighWaterMark` persisted separately (keystore item, not the config file) so reverting the file alone fails.
- **Load-time rule:** verify integrity → verify version ≥ high-water → verify signature/MAC → adopt or fail closed with safe error. Never auto-recover by regenerating (TRACE F-4 precedent).

## 3. Minimum signed fields

For any signed ceiling artifact (Options A/B):

```text
nodeId, ceilingVersion (monotonic int), issuedAt, expiresAt|null,
maxOperations[] (exact operation ids), maxDurationSeconds,
networkPolicy {none|allowlist[{scheme,host,port}]}, maxCostUsdMinor (int),
issuerKeyId, prevCeilingDigest (chain)
```

Signed over canonical sorted-key JSON (OPTS canonical note). `prevCeilingDigest` chaining gives cheap rollback detection even before the high-water check. No secrets, no per-job grants — this bounds the machine; leases bound jobs (OPTS hybrid recommendation, §closing).

Safe error codes (extend TRACE §1 categories): `ceiling_missing`, `ceiling_tampered`, `ceiling_rollback`, `ceiling_unsigned_issuer`, `ceiling_version_conflict`.

## 4. Rotation, recovery, and audit linkage

- **Rotation:** B rotates by owner-signed increment; A rotates via re-enrollment. Either way the node emits a `ceiling_adopted` audit event carrying `{oldDigest→newDigest, issuerKeyId}`; server-side reconciliation records the witnessed chain. A gap between local chain and server-witnessed chain = attention flag (not auto-block — offline rotation is legitimate).
- **Recovery:** lost/corrupt ceiling ⇒ fail closed, require re-provisioning by the same issuer class that provisioned originally. Never widen-by-default while waiting (THM T8 lesson).
- **Why a compromised Control Room cannot widen it:** under A/B/D the ceiling's *authority* derives from a key the server does not hold (owner enrollment factor / provisioning key / OS control plane). **This guarantee is conditional**: it requires (a) ceiling bytes signed by the owner inside enrollment and (b) the trust pin delivered out-of-band. If either condition fails, T1 containment does not hold. Under those conditions, the server can relay copies (C-as-transport), request changes, or withhold traffic — but every adoption path checks a signature the compromised key cannot produce, and version monotonicity blocks serving stale-but-valid narrower ceilings as a downgrade attack. The residual risk is availability (server stops relaying updates), not integrity — availability loss is the honest trade ADR-009 accepts ("Some actions pause for stronger confirmation").

## 5. Comparison summary

| Dimension | A Enrollment-bound | B Owner-signed config | C Server-signed | D Platform-bound |
|---|---|---|---|---|
| Survives compromised server (T1) | ●●●● * | ●●●● * | ●○○○ | ●●●● * |

\* Conditional, not absolute: T1 survival holds **iff** the ceiling bytes are owner-signed within enrollment AND the trust pin arrives out-of-band (never over a server-controlled channel). Absent those conditions a compromised server can substitute keys/re-sign ceilings and T1 is not contained. See Option A attacker-model row for the full statement.
| Same-UID resilience (T6) | ●●●○ | ●●●○ | ●●○○ | ●●●● (platform-dep.) |
| Rotation ergonomics | ●○○○ | ●●●● | ●●●● | ●●○○ |
| Fleet portability | ●●●● | ●●●○ | ●●●● | ●○○○ |
| Recovery story | ●●●○ | ●●●○ | ●●●○ | ●○○○ |
| Audit linkage | ●●●○ | ●●●○ | ●●●● | ●○○○ |
| New key material needed | none extra | provisioning key | none (fatal flaw) | none |

No option dominates. **B composes naturally with A** (A anchors the provisioning key + initial ceiling at enrollment; B provides cheap rotation thereafter) — the same composition logic OPTS used for its ceiling+lease-token hybrid. D layers on either as hardening. C stands rejected as an authority mechanism regardless of convenience.

## 6. Proposed test gates (whatever mechanism Codex selects)

1. Unit: tamper each durable-state field independently ⇒ `ceiling_tampered`, refuse start.
2. Unit: replay older valid signed version ⇒ `ceiling_rollback`, refuse (high-water + prev-digest chain both tested).
3. Property: fuzzed ceiling artifacts with secret-shaped fields pass through the secret-material guard before persistence (TRACE J-1 discipline).
4. Integration: server presents widened job while ceiling narrow ⇒ gate refuses with `operation_not_authorized` (this is U1/U2 from the acceptance plan — unchanged).
5. Integration: rotation while offline ⇒ new ceiling adopts on next owner delivery; server-witness chain converges later without blocking work.
6. Kill-boundary (CR-5Q): death between "verify new ceiling" and "commit high-water" ⇒ restart re-verifies; no window admits both versions.
7. Manual/platform: provisioning delivery per host (file drop on Mac/Windows; container mount decision for VPS ties into CON F1's D6 — same delivery channel question, likely same answer, decide together).

## 7. Explicitly left to Codex

Mechanism selection (recommendation shape: A+B hybrid, D as optional hardening); whether provisioning key == pause-operator key from DOSSIER (tempting for key-count economy, couples two compromise domains — flag for deliberate choice); expiry semantics of ceilings themselves (`expiresAt` above allows but does not mandate); interaction with lease-slice tokens if OPTS hybrid is adopted.

## Method note

Every claim tied to merged report citations (aliases in header) or line-verified source (`persistence.ts:73+`, `policy.ts:89`, `authority.ts:10`). `[P]` marks the only genuinely new proposals here (signed-field set, error codes, high-water mechanics, test gates); everything else organizes existing evidence. No mechanism implemented; no ADR made; no final selection stated beyond a labeled recommendation shape left for Codex disposition.
