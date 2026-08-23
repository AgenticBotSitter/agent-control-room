# CR-5C local operator pause/revocation decision dossier

**Status:** Complete 2026-08-23
**Worker route:** Marvin / macOS Mac mini / Hermes — security documentation research, medium risk.
**Purpose:** Compare candidate mechanisms for the local-operator emergency pause/revocation control flagged in the threat model (THM T6, case 12 of the adversarial matrix, trace G-1/G-2) and give the owner/Codex a decision-ready comparison. This dossier selects nothing and implements nothing.
**Repo state:** current `main` post-CR-5B. Citations: THM=#22 threat model, ATX=#21 adversarial matrix, INV=#20 inventory, TRACE=#27 requirements matrix.

**Source seams cited:**
| Ref | Location | Fact |
|---|---|---|
| L1 | `src/node-bridge/bridge.ts:16` | `BridgeState` includes `"draining"` — pause has a natural state to land in |
| L2 | `src/node-bridge/bridge.ts:180,187` | heartbeat/`tick()` already special-case `draining` |
| L3 | `src/domain/v1/types.ts:17` | node states include `draining`, `quarantined`, `revoked` server-side |
| L4 | `src/node-bridge/bridge.ts:163-168` | command frames currently land in `journal.recordCommand` unconditionally |
| L5 | `src/node-protocol/v1/types.ts:249` | principal states include `revoked`; auth rejects revoked at handshake (`authentication.ts:100-106`) |

## 1. The problem being solved

THM T6: *local user with filesystem access* can currently do nothing worse than read files — but the moment a pause mechanism exists, **the mechanism itself becomes an attack surface**: whoever can trigger it can also deny-service the node, or worse, whoever *can't* be stopped from triggering it defines whether "local human outranks network" is real (ATX case 12 invariant). The dossier question is: which mechanism gives the owner's physical presence strictly stronger authority than the network, without handing that same authority to any compromised local process?

Requirements any candidate must satisfy (from ATX case 12 + TRACE G-1/G-2):
1. Halts new command accepts immediately; works with zero connectivity.
2. Requires a defined local-authority signal — not "any writable file."
3. Mid-execution variant resolves via existing cancel or ambiguity paths (I-1), never silent kill.
4. Restart persistence semantics defined (pause survives? resume requires re-auth?).
5. Auditable: the pause event must reach the central audit chain eventually.

## 2. Candidate mechanisms

### M-A — Authenticated localhost control socket / CLI

A Unix-domain socket (or named pipe on Windows) bound to `127.0.0.1` only, speaking a minimal signed-command protocol; a small CLI (`control-room node pause|resume|revoke`) is the operator interface.

| Dimension | Assessment |
|---|---|
| Identity/authentication | Strongest option: peer credential check (SO_PEERCRED / getpeereid / Windows named-pipe client PID) pins the caller to an OS UID; plus an Ed25519-signed command using a dedicated **operator key stored in the same NodeKeyStore class as the node identity but separately protected** — this is the ADR-009 "separately protected factor" pattern applied locally [ADR-009 `CR3_DECISION_LOG.md:106-116`]. Both checks together = "right user AND holder of the operator factor." |
| Same-UID compromise | Partial: attacker with same UID passes peercred, but still needs the operator private key. Key held in OS keystore (per SYN §2 adapters) means compromise of process memory ≠ compromise of the factor. Residual: attacker with same UID + keystore unlock capability defeats it — accepted residual, documented. |
| Offline behavior | Fully offline; socket is loopback-only by construction. |
| Atomicity | Single state transition on L1's `BridgeState`; gate check at L4 reads one atomic flag. Clean. |
| Restart persistence | Pause state persisted as a journal record → survives restart; resume requires the same authenticated command (no auto-resume on reboot). |
| Auditability | Best of the three: pause/resume/revoke are structured events with signer identity → journal → next reconciliation report carries them server-side into the audit chain [INV G-row linkage]. |
| UX | Good: one CLI command; scriptable; works over SSH for headless nodes. |
| Portability | High with per-platform plumbing: UDS is native macOS/Linux; Windows needs AF_UNIX (Win10 1803+) or named pipes with equivalent peer-PID check [WIN §4 context]. All three probed hosts support one of these. |
| Pending vs in-flight | Natural split: gate stops pending commands at L4 immediately; in-flight effects resolve through existing cancellation/ambiguity paths (trace I-1/I-2) — no new semantics needed. |
| Cost/risk | Most implementation effort of the three (new IPC surface = new attack surface); must rate-limit/fail-closed the socket itself (reuse protocol rate-limiter pattern `rate-limit.ts`). |

### M-B — Protected OS-native service control

Model the bridge as an OS service (launchd/systemd/Windows service) and use the platform's own control plane: `launchctl disable/enable`, `systemctl stop/start`, `sc config` + restart, protected by OS privilege (root/admin or a dedicated service account).

| Dimension | Assessment |
|---|---|
| Identity/authentication | Delegated entirely to OS privilege model. Strong against other users; weak against same-UID/root compromise (root IS the authority). No Control Room-level operator factor — cannot express "owner factor separate from machine admin," which ADR-009's spirit wants. |
| Same-UID compromise | Weakest: any process with the right privilege level controls the service; there is no second factor. On Johnny5's container there is no systemd at all (LNX §1: PID 1 is ttyd, systemd offline) — mechanism partially nonexistent there today. |
| Offline behavior | Works offline. |
| Atomicity | Process-level stop is coarse: kills the connection loop wholesale rather than pausing accepts. In-flight effects get whatever SIGTERM handling exists — coarser than M-A's gate-level halt. |
| Restart persistence | Service disabled-state persists natively (that part is good), but "paused" vs "stopped" distinction is lost; resume-on-boot behavior differs per supervisor. |
| Auditability | Poor-to-indirect: OS logs exist but not in Control Room's journal/audit vocabulary; reconciliation would infer pause from missed heartbeats rather than receive a structured event. |
| UX | Familiar to admins; but three different toolchains across the three machines, and CR-5Q/CR-6 packaging owns the service layer anyway [WIN §4 service-topology decision D2]. |
| Portability | Medium: launchd ✓ (MAC context §1), systemd ✗ on current VPS container (LNX §1), Windows service possible but not installed (WIN §4 "no service topology installed"). Not portable to today's actual fleet without infra changes. |
| Pending vs in-flight | Cannot distinguish — whole-process semantics. In-flight effects become crash-boundary cases every time (forces the ambiguous path more often than necessary). |
| Cost/risk | Low implementation cost in CR-5C but pushes real complexity to CR-6 packaging; couples emergency control to deployment topology. |

### M-C — Protected local configuration / sentinel file

A sentinel file (e.g. `<state-dir>/PAUSED`) whose presence pauses the node; protection = directory ACLs to a dedicated group/owner; optionally the file must contain an HMAC/tag the bridge verifies.

| Dimension | Assessment |
|---|---|
| Identity/authentication | Weakest by default: file presence is unauthenticated unless content is verified. HMAC variant raises this to "holder of the operator secret" — but then it converges toward M-A's factor requirement with worse ergonomics (no transport, so revocation/revoke-vs-pause distinctions and structured payloads get shoehorned into file naming conventions). |
| Same-UID compromise | Worst: same-UID attacker creates/deletes the file at will (unless HMAC-verified, then equal to M-A minus transport security). TOCTOU between check and act is manageable but adds code paths. |
| Offline behavior | Fully offline — its main virtue. |
| Atomicity | File rename is atomic per-OS; bridge polls or uses FS watch. Polling interval introduces detection latency (bounded, configurable). |
| Restart persistence | Trivially persists (it's a file) — but that cuts both ways: stale sentinels silently keep nodes paused forever with no expiry semantics unless designed in. |
| Auditability | Weak: a file mutation is not an event; the bridge would journal "observed paused state" — attribution of *who* paused is structurally unavailable. THM boundary table wants denial/pause events auditable [THM §boundary summary]. |
| UX | Simplest conceptually ("touch a file"), but error-prone: wrong path, permissions drift, forgotten sentinel. LNX probe showed permission-drift is already a real failure mode on exactly this kind of file store [LNX §4 row]. |
| Portability | Excellent — a file works identically everywhere. This is its decisive advantage. |
| Pending vs in-flight | Same natural split as M-A if checked inside the gate (L4); polling latency delays detection by design. |
| Cost/risk | Lowest implementation cost; highest ambiguity about who did it and weakest authentication story. |

## 3. Threat-to-mitigation table

| Threat (from THM/ATX) | M-A socket+factor | M-B service control | M-C sentinel |
|---|---|---|---|
| T6 local user triggers unauthorized pause | Mitigated: needs UID **and** operator factor | Not mitigated for privileged-local-user; mitigated for cross-user | Unmitigated (plain) / partially (HMAC) |
| T2 compromised worker self-pauses to hide activity | Detectable: pause event is signed & journaled; forged entries need the factor | Undetectable in-band | Undetectable in-band |
| T8 stale grant execution during pause | Gate blocks queue→executor path regardless of grants (TRACE A-3 seam) | Blocks everything including legitimate reconciliation reporting | Same as M-A if gate-checked; delayed if polled |
| Deny-of-service via pause abuse | Rate-limited + attributed + reversible by owner from another terminal | Reversible via service control | Reversible, but attribution absent |
| Offline revocation (ATX 12c) | Supported: revoke command journaled locally, enforced at gate, reconciled later | Supported at process level only | Supported but unattributed |

## 4. Comparison summary

| Criterion (weight per packet emphasis) | M-A socket+operator-factor | M-B OS service control | M-C sentinel file |
|---|---|---|---|
| Authentication strength | ●●●● | ●●○○ | ●○○○ |
| Same-UID resilience | ●●●○ | ●○○○ | ●○○○ |
| Offline | ●●●● | ●●●● | ●●●● |
| Atomicity/precision | ●●●● | ●●○○ | ●●●○ |
| Restart persistence clarity | ●●●○ | ●●○○ | ●●●○ (with expiry design) |
| Auditability | ●●●● | ●○○○ | ●○○○ |
| UX | ●●●○ | ●●●○ | ●●●● |
| Fleet portability today | ●●●○ | ●○○○ (no systemd on VPS) | ●●●● |
| Implementation cost | high | low (but defers to CR-6) | lowest |

No single candidate dominates; the trade is **authentication+audit depth (M-A)** vs **simplicity+portability (M-C)**, with M-B mostly ruled out for the current fleet by the VPS's missing init system and its inability to express a separate operator factor.

## 5. Hybrid worth Codex's attention (noted, not chosen)

M-C's portability plus M-A's factor: sentinel file whose *content* must be a valid operator-key signature over `(node-id, action, timestamp)` — file transport, cryptographic authentication, offline, portable, auditable once observed-and-journaled. Costs: signature verification at poll time (cheap, Ed25519), timestamp freshness window to prevent replay of an old pause file, and the same operator-factor management burden as M-A. If Codex values portability over interactive UX, this hybrid captures most of both. Its open questions: freshness window length; where the operator public key lives (trust bundle extension vs node enrollment field — touches F-6/D5 territory).

## 6. Recommended acceptance tests (whichever mechanism is chosen)

1. **Pause halts accepts**: with bridge `online` (L1) and N queued commands, engage pause → gate refuses further `recordCommand`→consume transitions (L4 seam); queued-but-unvalidated commands stay queued, not executed.
2. **Offline enforcement**: disconnect transport, engage pause, deliver a validly signed over-ceiling command via journal replay after reconnect → refused with receipt category `locally_paused`.
3. **In-flight honesty**: pause mid-effect → effect resolves via existing ambiguity path (S6 `executing→ambiguous`), never killed silently; classification matches ATX case 10b expectations.
4. **Authentication negative tests**: wrong-UID caller (M-A) / missing operator signature (M-A/hybrid) / plain unauthenticated file (M-C baseline) → refused, attempt logged, rate-limited per protocol limiter pattern.
5. **Restart persistence**: pause → restart bridge process → still paused; resume requires fresh authorized action (no auto-clear).
6. **Audit convergence**: pause and resume events appear in the next reconciliation report and central audit chain with actor attribution where the mechanism provides it.
7. **Revocation precedence**: locally revoked node refuses even correctly-signed server work until explicit local re-auth — offline included (TRACE G-2).

## 7. Explicitly left to Codex/owner

Final mechanism selection; operator-factor provisioning/enrollment shape (interacts with SYN D5 trust-bundle decisions and F-6 rotation); whether pause authority should also cover lease renewal refusal; freshness window for the hybrid's signed sentinel; Windows transport choice (AF_UNIX vs named pipe) at CR-6 packaging time [WIN §4 D2 dependency].

## Method note

Every mechanism evaluation ties to either a stated assumption, a probe observation ([MAC]/[WIN]/[LNX] section refs), or existing source (L1–L5, all line-verified on current main). No generic security advice: where a claim rests on OS behavior (peercred, DPAPI profile loading, systemd absence), it cites the probe that established it. No mechanism was implemented, configured, or tested live.
