# CR-5C cross-platform key-store interface research synthesis

**Status:** Complete 2026-08-23
**Worker route:** Hermes / macOS Mac mini / provisional qualification — research-synthesis packet.
**Purpose:** Decision-ready options matrix for a portable `NodeKeyStore` / trust-store interface, built from the three completed platform probe reports. This report implements nothing and decides no ADR; every platform claim cites its probe, and open questions are routed to named future blocks.
**Repo state analyzed:** `main` @ `489cd6d`; probe branches `worker/marvin/11-macos-keystore-probe` (PR #19), `worker/ziggy/12-windows-keystore-probe` (PR #25), `worker/johnny5/13-linux-vps-keystore-probe` (PR #24).

**Probe citations used throughout:**
- **[MAC]** = `docs/hermes-reviews/CR5C_MACOS_KEYSTORE_CAPABILITY_PROBE.md`
- **[WIN]** = `docs/hermes-reviews/CR5C_WINDOWS_KEYSTORE_CAPABILITY_PROBE.md`
- **[LNX]** = `docs/hermes-reviews/CR5C_LINUX_VPS_KEYSTORE_CAPABILITY_PROBE.md`

## 0. Executive recommendation

Adopt a **two-mode portable interface**: a native mode per platform where a real OS keystore exists, and one uniform **encrypted-file fallback** mode that is identical code on all three platforms.

- **macOS:** native = Keychain generic-password holding the Ed25519 PKCS#8 blob [MAC §4.1].
- **Windows:** native = DPAPI CurrentUser envelope via PowerShell child at boot-unlock only [WIN §6.1].
- **Linux/VPS:** **no native keystore exists on the probed node** — encrypted-file with per-boot master-secret derivation *is* the primary mode there [LNX §2, §3.1].

The encrypted-file fallback is not a degraded afterthought; it is the shared portability spine, and on Linux it is primary. One code path + three thin native adapters minimizes surface area and makes the deterministic test-double strategy (§6) natural. All modes sign Ed25519 in software via Node crypto and hold the private key in process memory after unlock; none of the three platforms offered non-exportable Ed25519 hardware without protocol changes [MAC §3], so hardware-backed identity remains an explicitly deferred option (§7).

## 1. Common minimum interface

Derived from the descriptor shapes all three probes independently converged on ([MAC §6], [WIN "capability descriptor"], [LNX §5]) plus the existing bridge seams (`docs/CR5B_PORTABLE_NODE_BRIDGE.md`: `BridgeFrameSigner`, `NodeProtocolAuthenticator`, journal secret guard):

```text
NodeKeyStore (async, injected behind BridgeFrameSigner)
├─ reference()        → opaque descriptor {platform, mode, reference fields}   // serializable, no secret material
├─ availability()     → "available" | "locked" | "interaction-required" | "missing"
├─ unlock()           → loads private key into process memory; NEVER returns key bytes to callers
├─ sign(bytes)        → Ed25519 signature via in-memory key (after successful unlock)
├─ verifyTrust(ref)   → trust-store lookup for server-side public keys (CR-5A resolver contract)
├─ rotate/revoke      → explicit operator actions; never auto-regenerate (CR-5A identity immutability)
└─ lock()/dispose     → zeroize in-memory key; called on shutdown/lock transitions
```

**Safe error categories** (map platform-specific errors into these; never leak raw OS errors upward):
| Category | Trigger examples (per probe) |
|---|---|
| `locked` | macOS `errSecInteractionNotAllowed` after reboot/SSH [MAC §5]; Windows profile-not-loaded DPAPI failure [WIN §4] |
| `missing` | item/file absent ⇒ re-enrollment required, not regeneration [MAC §5 reset row; LNX §4 tamper row] |
| `corrupt` | GCM tag mismatch [LNX §4] |
| `permission-denied` | file-mode drift [LNX §4]; wrong-user DPAPI [WIN §6 fail-closed] |
| `unavailable-platform` | Linux native paths all blocked [LNX §2] |

## 2. Per-platform capability matrix

| Capability | macOS (M4 mini) | Windows 11 Home (RIG1) | Linux Debian 13 VPS (Docker) |
|---|---|---|---|
| Native keystore exists? | Yes — Keychain generic-password [MAC §2] | Yes — DPAPI + Credential Manager [WIN §2.1–2.2] | **No** — kernel keyrings seccomp-blocked, no D-Bus/Secret Service, no TPM, no systemd-creds [LNX §2] |
| Recommended v1 mode | Keychain generic-password (Ed25519 blob) [MAC §4.1] | DPAPI CurrentUser envelope, PowerShell-child route A [WIN §6.1] | Encrypted-file AES-256-GCM, root-owned 0600 [LNX §3.1] |
| Support confidence | High API surface / medium silent cross-build access (ACL prompt unverified — writes forbidden by packet) [MAC §2] | High for boot-unlock usage (~416 ms/op observed end-to-end) [WIN §3.1] | High — Node crypto verified working in-process [LNX §1] |
| Latency class | Boot-unlock (CLI subprocess); per-op cost unknown until ACL behavior tested [MAC §4.1] | Boot-unlock only (~416 ms/op measured) [WIN §3.1, §6.1] | Per-operation viable (in-process AES-GCM) but key stays memory-resident either way [LNX §3.1] |
| Hardware-bound keys available? | SEP P-256 only — no Ed25519; requires wire-contract change (ES256) [MAC §3] | TPM unconfirmed without elevation; judged disproportionate for v1 [WIN §2.3, §6.4] | None [LNX §2] |
| Service-context hazard | LaunchAgent inherits Aqua unlock; LaunchDaemon sees System keychain — wrong domain; SSH fails closed [MAC §5] | Service/scheduled task needs user profile loaded or DPAPI decrypt fails; LocalMachine scope over-broad [WIN §4] | Already headless/containerized; master secret must arrive via container start mechanism [LNX §3.1] |
| Backup/restore story | Items restore with account; no Time Machine destination configured on probe host (untested) [MAC §5] | Profile-bound; password reset destroys masterkeys ⇒ re-enrollment [WIN §5] | File copy = identity clone risk; detect server-side first-seen fingerprint [LNX §4] |
| Fail-closed behavior | throw on locked/missing ⇒ bridge backs off [MAC §5, §6] | throw on unlock failure [WIN §6.1] | refuse start on missing master secret / tag mismatch / permission drift [LNX §4] |

## 3. Selection logic (fails closed)

```
startup:
  desc = loadDescriptor(platform)            // static config, no discovery
  if desc.mode unavailable per matrix (§2)    → availability = "missing", refuse enrollment-dependent work
  try unlock():
    native adapter first (darwin→keychain, win32→dpapi-currentuser)
    on native error category ∈ {locked, interaction-required}
        → availability="locked"; bridge state=protocol_rejected/backing_off; retry with backoff
    on category ∈ {missing, corrupt, permission-denied}
        → require re-enrollment; emit denial receipt; NO auto-regeneration
  fallback policy (config flag, default ON for linux, OFF for darwin/win32):
    native unavailable AND fallback allowed
        → encrypted-file mode; derive root key from master-secret source
        → master-secret source missing ⇒ availability="locked", backoff loop
runtime:
  sign() before unlock(), or after lock()/dispose   → error "key-not-unlocked" (fail closed)
  any unlock path MUST NOT write key bytes to journal/logs (reuse CR-5B secret guard)
```

Design notes:
- Mode selection is **static per deployment**, not runtime-discovered — matches the spec's hardcoded-path philosophy and avoids a bridge choosing its own trust level mid-life.
- The fallback flag defaults differ per platform because on Linux fallback-is-primary while on mac/win falling back silently would *weaken* protection without anyone noticing; a silent downgrade should be an explicit config decision.
- Every transition emits an availability state the bridge can expose (ties into threat-model case 8, PR #22).

## 4. What must never be persisted anywhere

| Location | Never contains | Enforced by / note |
|---|---|---|
| SQLite journal (`SqliteBridgeJournal`) | private keys, resolved secrets, plaintext envelopes of secret-bearing bodies | central secret-material guard on every write [CR-5B doc; WIN §5 confirms co-location safe *because* of this guard] |
| Control Room database | node private keys (only public-key SPKI + state per CR-5A), approval evidence beyond digests | schema review PRs #3/#19 lineage |
| Repository | any credential, token, probe secret, real hostname/SID/account name | probes redacted [WIN acceptance checks; MAC/LNX stop boundaries] |
| Logs / telemetry | raw OS security errors containing paths/user names; key bytes; master secrets | map through §1 safe-error categories first |
| Descriptor files | key material — descriptors hold references only ([MAC §6]/[WIN]/[LNX §5] shapes agree) | property-test: descriptor ∩ key bytes = ∅ |

Additionally (from probes): no DPAPI ciphertext transit in command-line arguments where avoidable (Windows route A transits *encrypted* blob via stdout — acceptable since already encrypted [WIN §3.1 note]); no Credential Manager entries created by automated tests [WIN packet constraint precedent].

## 5. Portable test-double strategy

Goal: CR-5C unit tests run deterministically on CI (all platforms) with zero platform keystores.

1. **In-memory fake `NodeKeyStore`** implementing the §1 interface exactly: instant `available`, deterministic sign (fixed test key), records call order. Bridge tests inject it where `BridgeFrameSigner` already accepts injection [CR-5B seam].
2. **Scenario fakes** driven by a single knob: `fake.availability = available|locked|missing|corrupt|permission-denied` — each maps to the §1 safe-error category, letting every fail-closed branch (§3) be unit-tested without any OS.
3. **Encrypted-file mode is its own integration test target**: it is pure Node crypto (verified working on all three probes' Node versions [MAC §1][WIN §1][LNX §1]), so its round-trip/tamper/permission tests run on every CI runner — this doubles as the Linux-primary implementation test.
4. **Native adapters get thin smoke tests, skipped unless platform-matched and explicitly enabled** (env-gated), following the probes' own constraint discipline: constant vectors only, create-then-delete one disposable item, never touch real identities [MAC §7.3 manual list; WIN test strategy §test-strategy].
5. **Property tests:** descriptor serialization round-trip; secret-guard sweep over all store outputs; sign-before-unlock refusal.
6. Manual platform validation (owner-supervised) stays reserved for exactly what probes flagged unverified: macOS cross-build ACL prompts [MAC §2], Windows service-context profile loading [WIN §4], Linux container-profile changes [LNX §2 closing note].

## 6. Interface fit with existing contracts

- `BridgeFrameSigner` needs no change: the store sits *under* it; unlock-at-start feeds it an in-memory signer [CR-5B portable boundary].
- `NodeProtocolAuthenticator` trust lookup maps to `verifyTrust(ref)`; server-trust bundle delivery currently happens once at enrollment [inventory row E8, PR #20] — rotation remains an open decision (§7).
- Journal co-location is acceptable precisely because of the secret guard [WIN §5 last row]; keep that invariant load-bearing in code review.

## 7. Unresolved decisions and ownership

| # | Open decision | Evidence pull | Owner block |
|---|---|---|---|
| D1 | macOS cross-build ACL prompt behavior (determines whether a fixed codesigning identity is needed) | MAC §2 "unverified", §7.3d | CR-5C manual validation round; disposable machine or owner approval required |
| D2 | Windows service topology: guarantee profile-loaded vs LocalMachine+ACL vs interactive-unlock-only | WIN §4 failure summary | CR-6 packaging |
| D3 | Linux container posture: relax seccomp/caps for kernel keyring (then ranking flips [LNX §3.3]) vs accept encrypted-file permanently | LNX §2, §3 | Owner infra change + CR-5C revisit gate |
| D4 | Hardware-bound identity (SEP P-256 / TPM): requires ES256 support in CR-5A authenticator — protocol change | MAC §3 strategy B; WIN §2.3 | Architecture decision, Codex/Sol; deferred past CR-5C v1 |
| D5 | Server trust-bundle rotation mechanism (no refresh path today; compromised server key ⇒ re-enroll everything) | inventory E8 (PR #20); threat model T8/residual 2 (PR #22) | CR-5C or CR-6; must be decided before first real deployment |
| D6 | Master-secret delivery mechanism for Linux encrypted-file mode (container env/mount vs host systemd-creds) | LNX §3.1 pros/cons | CR-6 deployment design |
| D7 | Whether silent native→fallback downgrade is ever permitted, or always requires explicit config | §3 selection logic rationale | CR-5C ADR author |

## Method note

Built solely from: the three probe reports as delivered on their worker branches (citations above), `docs/CR5B_PORTABLE_NODE_BRIDGE.md`, `docs/CR5A_NODE_PROTOCOL_AND_IDENTITY.md`, `src/node-bridge/bridge.ts` exports, and the previously merged review artifacts (PR #20 inventory, PR #22 threat model). No code executed; no package/API behavior asserted beyond what probes observed or cited as documented. Where a probe marked a claim `[inference]`, this report carries the same uncertainty forward rather than upgrading it.
