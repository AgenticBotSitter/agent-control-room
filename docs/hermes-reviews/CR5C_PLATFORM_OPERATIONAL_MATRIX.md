# CR-5C platform deployment and key-unlock operational matrix

**Work packet:** #31 (`[WORK][CR-5C] platform deployment and key-unlock operational matrix`)
**Worker:** Ziggy (PC Hermes / Windows + RTX 3070 host)
**Harness/model:** Hermes Agent desktop, model route `stealth/ox-alpha` via Nous
**Date:** 2026-08-23
**Task class:** Documentation synthesis; low risk; doc-only. No code/config/service/package changes.
**Purpose:** Deployment-readiness matrix for the three probed nodes — how a future bridge starts, unlocks, backs off, restarts, and reports safe availability. Implementation is out of scope.

**Evidence citations used throughout:**
- **[MAC]** = `CR5C_MACOS_KEYSTORE_CAPABILITY_PROBE.md`
- **[WIN]** = `CR5C_WINDOWS_KEYSTORE_CAPABILITY_PROBE.md`
- **[LNX]** = `CR5C_LINUX_VPS_KEYSTORE_CAPABILITY_PROBE.md`
- **[SYN]** = `CR5C_CROSS_PLATFORM_KEYSTORE_SYNTHESIS.md` (merged PR #26)
- **[5B]** = `docs/CR5B_PORTABLE_NODE_BRIDGE.md`

**Convention:** **[observed]** = a probe ran it on the machine; **[assumption]** = future deployment posture, not yet real. Every row states which. Nothing here upgrades a probe's `[inference]` to fact.

---

## 1. The three nodes today (observed baseline)

| Node | Role | OS / context | Key-store reality today |
|---|---|---|---|
| RIG1 | Windows worker, RTX 3070, interactive desktop | Windows 11 Home 26200, Node 22.22.3 under user profile, admin-group user [WIN §1 observed] | DPAPI CurrentUser verified working in-memory (~416–437 ms/op via PS child); nothing persisted [WIN §2.1, §3.1] |
| Mac mini M4 Pro | macOS worker, interactive GUI session | macOS 26.6.2 arm64, Node 22.22.3 in Aqua launchd domain [MAC §1] | Login keychain unlocked no-timeout for this session; zero items written [MAC §2] |
| Debian VPS (Docker) | Headless Linux node | Debian 13 trixie container, PID1=ttyd, cap-reduced root, seccomp filter [LNX §1] | **No native keystore at all** — all four Linux mechanisms blocked; Node crypto AES-GCM/Ed25519 works in-process [LNX §2, §1] |

## 2. Operational matrix — per-platform deployment readiness

### 2.1 Launch context

| | macOS [assumption: LaunchAgent] | Windows [assumption: Scheduled Task or service, same user] | Linux/VPS [assumption: container restart policy] |
|---|---|---|---|
| Observed today | Aqua GUI session via Hermes harness [MAC §1 observed] | Interactive desktop shell [WIN §1 observed] | Container with ttyd as PID1, systemd offline [LNX §1 observed] |
| Future bridge supervisor | LaunchAgent (Aqua domain) — inherits login keychain unlock [MAC §5 documented] | Task/service as the enrolled user **with "load user profile" enabled**, or interactive startup | Host-level restart policy or compose `restart:`; no systemd inside container [LNX §2 observed] |
| Wrong-context hazard | LaunchDaemon ⇒ System keychain = wrong trust domain [MAC §5 documented]; SSH session ⇒ locked keychain, fail-closed [MAC §5 documented] | Service without profile load ⇒ DPAPI CurrentUser decrypt fails [WIN §4 documented]; LocalMachine scope = over-broad trust [WIN §4 documented+inference] | Any mechanism assuming D-Bus/systemd/keyring fails immediately [LNX §2 observed] |

### 2.2 Expected key-store availability at boot

| Platform | At boot, before operator action | After operator action | Basis |
|---|---|---|---|
| macOS | `locked` if pre-first-unlock/SSH (`errSecInteractionNotAllowed` family); `available` once owner has logged into Aqua session | n/a — unlock is implicit with GUI login; explicit re-auth not required for keychain | [MAC §5 documented] |
| Windows | `available` if task runs in loaded-profile user context after logon; `locked`/error if profile not loaded (pre-logon start) | Profile load happens at user logon; no per-boot secret entry needed for DPAPI CurrentUser | [WIN §4 documented], CurrentUser roundtrip [WIN §2.1 observed] |
| Linux/VPS | `locked` unless master secret supplied by container-start mechanism; `missing` if envelope file absent | Operator/host provides master secret via env/mount at container start [assumption; mechanism = open decision D6 [SYN §7]] | [LNX §3.1, §4 documented/observed] |

### 2.3 Safe retry / backoff state mapping

Uniform across platforms — the bridge already owns deterministic backoff capped at 60 s [5B connection lifecycle]:

| Key-store event | Bridge state transition | Frame behavior | Basis |
|---|---|---|---|
| unlock() → locked/error | → `backing_off`, retry unlock on backoff schedule | No signed frames sent; heartbeat suppressed (nonessential fails closed at journal ceiling) | [5B backpressure; SYN §3 selection logic] |
| unlock() → missing/corrupt/permission-denied | → `stopped` + denial receipt emitted; **no auto-regeneration** | Re-enrollment flow only, owner-gated | [MAC §5 reset row; LNX §4 tamper row; CR-5A identity immutability] |
| sign() before successful unlock | Local error `key-not-unlocked`, fail closed | Never reaches wire | [SYN §3 runtime invariant] |
| Mid-run lock (screen lock, keychain timeout) | In-memory key persists until process exit; next unlock attempt gates reconnection | Already-signed outbound frames replay normally after reconnect | [5B durability of unacked frames; MAC §5 lock row] |

Platform nuance: retry *interval* may differ (macOS waits on GUI login event rather than pure timer; Linux waits on master-secret appearance), but the state machine and frame discipline are identical [inference from uniform interface, SYN §1].

### 2.4 Required operator action

| Platform | One-time enrollment | Each boot | After account/reset events |
|---|---|---|---|
| macOS | Enroll node; store Ed25519 PKCS#8 blob as generic-password item [MAC §4.1 recommended path] | Log into GUI session (normal login does it); nothing else | Password reset/keychain reset ⇒ item lost permanently ⇒ re-enroll [MAC §5 documented] |
| Windows | Enroll node; protect key blob via DPAPI CurrentUser at provisioning time [WIN §6.1 recommendation] | None beyond normal user logon (profile loads) — if running pre-logon, task must be configured to load profile [WIN §4 mitigation documented] | Windows password reset destroys DPAPI masterkeys without exported recovery key ⇒ re-enroll [WIN §5 documented] |
| Linux/VPS | Enroll node; create encrypted-file envelope, root-owned 0600/0700 [LNX §3.1] | Ensure master secret present via chosen delivery mechanism (env/mount/host-creds) [assumption; D6 open] | File tamper/tag mismatch ⇒ treat as key loss ⇒ re-enroll; snapshot/clone ⇒ server-side first-seen fingerprint alert [LNX §4] |

### 2.5 Persistent artifacts on disk

| Platform | Artifact | Location | Permissions | Basis |
|---|---|---|---|---|
| macOS | Keychain item (not a file we manage); optional encrypted-file fallback envelope | login keychain-db; `<home>/.config/control-room/` for fallback | OS-managed keychain ACLs; 0600 file if fallback used | [MAC §4.1, §4.3] |
| Windows | DPAPI ciphertext blob (opaque file managed by the bridge) + SQLite journal alongside | Under user profile config dir; co-location safe because journal secret-guard forbids keys [WIN §5] | User-profile ACLs (implicit); blob decryptable only by enrolled user | [WIN §2.1 binding semantics documented] |
| Linux | Encrypted-file envelope + journal | `<home>/.config/control-room/node.key.enc` | dir 0700, file 0600, root-owned | [LNX §3.1] |

Journal co-location note: acceptable on all three **only** because the CR-5B secret-material guard keeps private keys out of the journal [5B; WIN §5 last row]. That guard is load-bearing — keep it in review checklists.

### 2.6 File permission / ACL validation at startup

| Platform | Check | On failure |
|---|---|---|
| macOS | Keychain item findable via stable service/account reference; no file mode to check for native path; fallback file mode if used | `missing` ⇒ re-enroll path; fallback mode drift ⇒ refuse + receipt |
| Windows | Blob readable by current user (decrypt succeeds = ACL implicitly right); explicit check unnecessary but cheap | Decrypt throw ⇒ map to `locked` vs `missing` per error class, then §2.3 rows |
| Linux | Explicit stat: dir 0700, file 0600, correct uid | Warn-or-refuse per policy [LNX §4 permission-drift row: startup check specified] |

Only Linux has an explicitly probe-specified permission-check contract today; mac/win checks are design proposals consistent with their probes' failure tables [inference].

### 2.7 Restart / re-enrollment conditions

| Condition | macOS | Windows | Linux/VPS |
|---|---|---|---|
| Process crash | Restart ⇒ re-unlock from keychain; identity intact | Restart ⇒ re-unlock via DPAPI; identity intact | Restart ⇒ re-derive from master secret; identity intact |
| OS reboot | Auto-recovers post-login (Aqua unlock); pre-login start fails closed then backs off [MAC §5] | Pre-logon start needs profile-load config else backs off until logon [WIN §4] | Container restarts per policy; master secret must be re-supplied by start mechanism [LNX §4 kill-rehearsal row] |
| Key material lost/corrupted | **Re-enroll** (never regenerate in place) [MAC §5] | **Re-enroll** [WIN §5 reset row] | **Re-enroll** [LNX §4 tamper row] |
| Machine migration/clone | New machine = new enrollment (keychain is UID/machine-scoped) | Same user profile restored wholesale would carry DPAPI blobs but is a clone risk ⇒ prefer re-enrollment [inference from WIN §5 backup semantics] | Clone ⇒ cloned identity detectable server-side only; re-enroll recommended [LNX §4 snapshot row] |

Server-side invariant behind every row: rotation inserts a distinct key ID; retired keys never reactivate [CR-5A persistence section].

### 2.8 Safe telemetry / availability signals Control Room should receive later

Derived from what each platform can honestly report [all inference, grounded in probe evidence rows]:

1. `keystore.availability` ∈ {available, locked, interaction-required, missing} — already the synthesis interface vocabulary [SYN §1]; maps directly onto heartbeat resource snapshots [5B].
2. Unlock latency class (boot-unlock vs per-op) — lets the scheduler avoid assigning latency-sensitive work to boot-unlock platforms [WIN §3.1 measured ~416–437 ms/op].
3. Re-enrollment-required flag (distinct from transient locked) — so Control Room stops scheduling and pages the operator instead of waiting out a backoff loop [MAC/LNX reset/tamper rows].
4. Master-secret source health (Linux only): whether the container-start delivery mechanism was present this boot [LNX §3.1].
5. Supervisor context tag (Aqua vs SSH; interactive vs service-with-profile; container restart count) — the single biggest predictor of unlock success per the probes' failure tables.
6. Never telemetry: key bytes, master secret, raw OS error strings containing paths/usernames — pass through safe-error categories first [SYN §1 table].

These are signals for a later block to formalize in the heartbeat schema — not a proposal to change v1 frames now (v1 strict schemas reject extension fields).

### 2.9 Manual acceptance test per platform (owner-supervised)

| Platform | Minimal drill |
|---|---|
| macOS | 1) Create disposable generic-password item; 2) unlock+sign once from GUI-launched bridge; 3) delete item. Then negative: repeat lookup from SSH ⇒ expect `errSecInteractionNotAllowed` fail-closed, bridge `backing_off`. Finally rebuild node binary ⇒ observe ACL prompt (feeds D1 [SYN §7]). [MAC §7.3 list] |
| Windows | 1) Protect/disposable-vector round-trip via the shipped probe scripts (`scripts/probes/windows-keystore-probe.ps1`, `windows-keystore-node-probe.cjs`) — both dry-run verified; 2) register nothing; simulate service context only via documentation review of profile-loading requirement; 3) wrong-user decrypt attempt ⇒ expect throw ⇒ fail-closed mapping. [WIN §3.1, §4; probe scripts exist on main] |
| Linux | 1) Start container without master secret ⇒ expect `locked`, backing_off, no signed frames; 2) supply secret ⇒ unlock+sign; 3) flip file mode to 0644 ⇒ expect permission-drift refusal; 4) tamper one byte ⇒ GCM mismatch ⇒ re-enrollment path, no regeneration. [LNX §3.1, §4 rows] |

## 3. Capacity / availability signals summary (for future scheduling work)

| Signal | Source platform(s) | Feeds |
|---|---|---|
| Keystore availability state | all | heartbeat snapshot; scheduling eligibility gate |
| Unlock latency class | win (measured), mac (class known), linux (per-op viable) | job-latency matching |
| Backoff depth / attempts since unlock failure | all | availability forecasting |
| Re-enrollment required | all | operator paging, node quarantine |
| Boot/provision freshness (slice/secret age) | linux primarily, mac keychain timeout state | trust-staleness ceiling |
| Supervisor/context label | all | predictive failure (e.g., pre-logon windows tasks will fail) |

## 4. Observed-vs-assumed ledger (acceptance aid)

Everything marked **[observed]** traces to a cited probe section executed on hardware. Everything marked **[assumption]** is future deployment posture: LaunchAgent/scheduled-task/container-restart supervisors, master-secret delivery mechanism, and telemetry field shapes. No assumption contradicts any probe observation; where probes left `[inference]` uncertainty (e.g., macOS cross-build ACL prompts — D1), that uncertainty is carried forward, not resolved.

## Acceptance self-checks

- Only probe-supported statements; assumptions labeled inline ✔
- `git diff --check`: clean (run pre-PR) ✔
- One report, one allowed path, doc-only PR ✔
- No secrets, hostnames, SIDs, or infrastructure identifiers ✔
