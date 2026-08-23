# CR-5C Linux/VPS protected-key-store capability probe

**Status:** Complete 2026-08-23
**Worker route:** Johnny5 / Debian 13 VPS (Hostinger, Docker/containerd) / Hermes Agent / provisional qualification route
**Task class:** Qualification; low risk; report-only.
**Stop boundary honored:** No secret material persisted (all smoke keys/ciphertexts created in memory or `/tmp` and deleted); no packages installed; no daemon changes; no live integration. All probes read-only except two explicitly noted `/tmp` ciphertext smokes (deleted) and GnuPG's default `~/.gnupg` initialization (empty, 0700).
**Repo state analyzed:** `main` @ `489cd6d` (CR-5B complete).

## 1. Environment evidence (observed)

| Item | Value | Claim class |
|---|---|---|
| OS | Debian GNU/Linux 13 (trixie), kernel 7.0.0-30-generic, x86_64 | observed |
| Isolation | **Docker/containerd container** (overlayfs root, `/.dockerenv` present), PID 1 = `ttyd`, **no systemd as init** (`systemctl is-system-running` → `offline`) | observed |
| Privilege | uid=0 (root) inside container, but **reduced capability set**: `CapEff=00000000a80425fb` — no `CAP_SYS_ADMIN`, no `CAP_SYS_MODULE`; CapBnd equals CapEff so they cannot be regained in-container | observed |
| Seccomp | Filter mode 2 (filter) active, 1 filter — Docker default profile | observed |
| Node.js | v20.19.2 at `/usr/bin/node`, OpenSSL 3.5.5 | observed |
| Git | available; deploy-key SSH access to GitHub works | observed |
| TPM | **No TPM device** (`/dev/tpm*` absent, empty `/sys/class/tpm`); `systemd-analyze has-tpm2` → `partial` (firmware/driver reported by host namespace, but no system TSS2 libraries usable in-container). Verdict: **TPM unavailable from this node** | observed |
| Kernel keyrings | **Blocked.** `add_key(2)` returns `EPERM` even as root (raw syscall tested); `/proc/keys` unreadable (containerized); `keyctl` binary not installed and user namespaces blocked (`unshare --user` → EPERM), so no workaround path in-container | observed |
| D-Bus / Secret Service | **Absent.** No `dbus-daemon`, no `gnome-keyring-daemon`, no `libsecret`, no `secret-tool`; `$DBUS_SESSION_BUS_ADDRESS` unset. There is no desktop session on a headless VPS to host one | observed |
| Disk encryption | None at this layer: root is overlayfs over host storage; LUKS/dm-crypt status is a **host-level concern invisible to this node** | observed |
| Crypto primitives (in-process) | Ed25519 sign/verify via Node `crypto.generateKeyPairSync('ed25519')`: **works**; AES-256-GCM encrypt/tag: **works** (memory only) | observed |

## 2. What this platform cannot offer (negative results — most important findings)

1. **No native protected key store.** All four usual Linux mechanisms are unusable here:
   - kernel keyrings — seccomp-blocked (`EPERM`);
   - Secret Service / gnome-keyring — no D-Bus session, headless;
   - TPM 2.0 — no device, no TSS libraries;
   - systemd-creds — requires systemd as PID 1 (PID 1 is `ttyd`); `systemd-creds` binary exists but has no working backend.
2. **No privilege escalation available in-container** to create any of the above (cap-bound, userns blocked). Fixing any of these requires *host-side* change by the owner: e.g. adding `--cap-add`, adjusting seccomp profile, mounting a TPM, or running the node under systemd on the host. That is out of scope for this packet but is the gating fact for CR-5C design.

## 3. Viable implementation paths, ranked

1. **Root-owned encrypted-file store (recommended for this node class).** AES-256-GCM envelope file under `<home>/.config/control-room/`, mode 0600, directory 0700. Root key derived per-boot from one of:
   - a root-held master secret passed at container start (environment/file mount outside the image);
   - systemd-creds **on the host** if the node process is later moved to a host-level systemd unit.
   Pros: zero new dependencies (Node crypto only, verified working), portable shape shared with macOS path 3 (encrypted-file fallback), fail-closed trivially. Cons: key-at-rest protection is only as strong as the master-secret delivery mechanism — this must be stated honestly in CR-5C docs rather than implied otherwise.
2. **GnuPG symmetric envelope.** Verified working (`gpg -c` AES256, batch passphrase-fd). Useful when a human-passphrase recovery story is wanted; unsuitable for unattended restarts without an agent holding the passphrase. Confidence high (observed).
3. **Kernel keyring (blocked today).** Would be the cleanest ephemeral-at-rest option (`add_key` + session ring dies with the session) but is seccomp-denied. If the owner relaxes the container profile, this becomes path 0 and the ranking flips for reboot-survival vs. ephemeral trade-offs — decision required from Codex/Sol.

## 4. Failure modes

| Failure mode | Expected behavior | Verification class |
|---|---|---|
| Master secret missing at bridge start | Fail closed: refuse to start signing seam; emit denial receipt; retry with backoff | unit-testable with injected descriptor |
| Envelope file corrupted / tampered (GCM tag mismatch) | Treat as key loss → require re-enrollment, never auto-regenerate (identity immutability, CR-5A) | unit + manual |
| Container restart / crash | Key re-derived from master secret each boot; journal replay must tolerate key being briefly unavailable (`availability: locked`) | kill-rehearsal (CR-6 gate) |
| File-permission drift (chmod/chown accident) | Startup permission check on dir/file (0700/0600); warn-or-refuse per policy | unit |
| Snapshot/clone of the container filesystem | Cloned node presents cloned identity → detect via server-side first-seen fingerprint and alert; local detection impossible (documented limitation) | documented |
| Host migration | Same as snapshot risk; re-enrollment procedure required | documented |

## 5. Proposed capability descriptor shape (no production interface code)

```jsonc
// Symbolic shape only — CR-5C owns the real schema.
{
  "platform": "linux",
  "mode": "encrypted-file",            // only viable mode on this node today
  "reference": { "path": "<home>/.config/control-room/node.key.enc" },
  "masterSecretSource": "env" ,        // | "host-systemd-creds" (future)
  "availability": "available",         // | "locked" | "missing"
  "signAlgorithm": "Ed25519",
  "nonExportable": false,
  "failClosedOn": ["missing-master-secret", "auth-tag-mismatch", "permission-drift"]
}
```

Maps onto the existing `BridgeFrameSigner` injection seam (`docs/CR5B_PORTABLE_NODE_BRIDGE.md`): CR-5C needs one conforming descriptor plus a Linux factory that fails closed.

## 6. Cross-platform note for #17 synthesis

macOS probe (#11) ranked Keychain generic-password first with encrypted-file as the uniform portable fallback; **on Linux/VPS the encrypted-file fallback IS the primary**. A single `encrypted-file` mode with per-platform master-secret sources gives one code path across darwin/linux/windows with honest per-platform ceilings. Windows (#12) remains unprobed (no machine assigned).

## Commands run (all read-only unless noted)

`cat /etc/os-release`, `uname -rm`, `ps -p 1`, `which systemctl/systemd-creds/keyctl/secret-tool/gpg/age/openssl`,
`dpkg -l | grep keyutils|libsecret`, `ls /sys/class/tpm /dev/tpm*`, `systemd-analyze has-tpm2`,
`cat /proc/self/status` (Caps, Seccomp), `capsh --decode`, `id`, `cat /proc/keys`,
`unshare --user` (blocked), raw `add_key(2)` syscall probe (EPERM),
Node memory-only Ed25519 sign/verify and AES-256-GCM smokes,
two `/tmp` ciphertext smokes (gpg symmetric, openssl enc) — **both deleted**,
`gpg --list-keys` initialized default empty `~/.gnupg` (side effect noted above).

## Assumptions / known risks

- Host disk may be LUKS-encrypted at the hypervisor level; invisible and unverifiable from in-container. Report treats at-rest protection as **not provided by this node**.
- Capability/seccomp posture could be changed by the owner; if so, §3 ranking should be revisited before implementation.
