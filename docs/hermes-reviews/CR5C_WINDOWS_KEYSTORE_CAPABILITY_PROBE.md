# CR-5C Windows protected-key-store capability probe

**Work packet:** #12 (`[WORK][CR5C] Windows protected-key-store capability probe`)
**Worker:** Ziggy (PC Hermes / Windows + RTX 3070 host)
**Machine:** RIG1 — Windows 11 Home, build 10.0.26200
**Harness/model:** Hermes Agent desktop, model route `stealth/ox-alpha` via Nous
**Date:** 2026-08-23
**Task class:** Qualification; low risk; report-only. Non-destructive per packet constraints.
**Claim markers:** every claim below is tagged `[observed]`, `[documented]`, or `[inference]`.

---

## 1. Environment evidence

| Item | Value | Marker |
|---|---|---|
| Windows edition | Windows 11 Home | [observed] |
| Build | 10.0.26200 (26200.9168) | [observed] |
| Node | v22.22.3 (x64), npm 10.9.8 | [observed] |
| Node install shape | Hermes-managed node under the user profile (not a system-wide install) | [observed] |
| Account context | Standard interactive user account; member of local Administrators group | [observed]; group membership checked without elevation |
| PowerShell | Windows PowerShell 5.1 (26100.9168) available at `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe` | [observed] |
| Host name | redacted (see acceptance checks) | [observed] |

No admin elevation was used or needed for any probe in this report.

## 2. Available Windows-native primitives and binding semantics

### 2.1 DPAPI (`CryptProtectData` / .NET `ProtectedData`)

- `System.Security.Cryptography.ProtectedData` round-trip succeeded in **CurrentUser** scope: protect → unprotect of a constant test vector returned the original bytes; blob size 246 bytes for a ~21-byte plaintext. `[observed]`
- **LocalMachine** scope also produced a valid blob on this machine. `[observed]`
- Entropy parameter accepted (blob bound to caller-supplied additional entropy). `[observed]`
- Binding semantics: CurrentUser blobs decrypt only under the same Windows user account and (by default) same profile; LocalMachine blobs decrypt under any account on that machine. `[documented]`
- First probe attempt failed with "Unable to find type ProtectedData" until `Add-Type -AssemblyName System.Security` was run — PS 5.1 does not load it implicitly. This is an integration detail a bridge must not forget. `[observed]`

### 2.2 Credential Manager (`advapi32!CredReadW`/`CredWriteW`)

- P/Invoke type-load of `advapi32!CredReadW` succeeded without elevation. `[observed]`
- The vault is populated by OS components on this machine (Microsoft account SSO entries, Xbox Live). Metadata-only listing performed; **no write probes were made**, per packet constraint against persisting test secrets. `[observed]`
- Binding semantics: generic credentials are stored per-user in the user's profile vault, encrypted at rest with DPAPI under that user; they roam only with roaming profiles. `[documented]`

### 2.3 TPM / NCrypt

- `Get-Tpm` returned no data in a non-elevated session; TPM readiness could not be confirmed without elevation. TPM key storage via NCrypt (`MS_KEY_STORAGE_PROVIDER`) was therefore **not exercised**. `[observed]` (query blocked) / `[documented]` (NCrypt semantics)
- Inference for design purposes only: TPM-bound keys protect key *material* but require a native CNG bridge and elevation-sensitive enrollment; they are out of proportion for a v1 node key store. `[inference]`

## 3. How a Node 22 process can reach each path safely

### 3.1 DPAPI from Node — three real options

| Route | Native dependency | Evidence |
|---|---|---|
| A. PowerShell child process calling `ProtectedData` | none (ships with Windows + Node) | `[observed]` |
| B. Native addon (`@primno/dpapi` v2.0.1 exists on npm; `win-dpapi` v1.1.0 exists but is stale) | prebuilt or compiled addon | `[documented]` (npm registry metadata only; nothing installed) |
| C. Direct P/Invoke equivalent from Node | would require N-API addon anyway — collapses into B | `[inference] |

Route A was executed end-to-end from this machine's Node 22:

- `child_process.execFileSync(powershell, ['-NoProfile','-NonInteractive','-Command', …])` protecting a constant vector: OK. `[observed]`
- Unprotect round-trip back to the original vector: OK. `[observed]`
- Latency: **~416 ms per operation**, dominated by process spawn + assembly load. `[observed]`
- Probe script retained at `scripts/probes/windows-keystore-node-probe.cjs` (dry-run, constant vector, persists nothing).

Design consequence `[inference]`: Route A is safe and dependency-free but its latency confines it to unlock-once-at-boot usage (fetch the node private key once into process memory at bridge startup), never per-frame signing. Per-operation use would add hundreds of milliseconds to every signed frame.

Note on repo module shape: the repository declares `"type": "module"`, so any CommonJS probe script must use `.cjs`. `[observed]`

### 3.2 Credential Manager from Node

Same three routes apply (PowerShell child invoking `CredWriteW`/`CredReadW`; or a native addon such as `keytar`'s successor libraries / direct N-API). No write probe was performed by packet constraint. `[documented]` + `[inference]`

Safety properties relevant to the bridge `[documented]`:
- Storage and retrieval are separate OS operations; the secret never transits a command line argument if written via API (unlike DPAPI-over-PowerShell where the ciphertext does transit stdout — acceptable since it is already encrypted).
- Vault entries are user-bound and survive reboots independent of any file layout.

## 4. Interactive vs service/scheduled-task contexts

- Interactive session: all probes above ran in a normal desktop-launched shell and succeeded without elevation. `[observed]`
- Scheduled task / service running as the same user: DPAPI CurrentUser decryption requires the target account's **user profile to be loaded**. Services and tasks that start before logon run with profile loading off by default, and `CryptUnprotectData` then fails (typically `ERROR_FILE_NOT_FOUND` from DPAPI). `[documented]`
- Mitigations exist (`LoadUserProfile` by the service, "load user profile" flag on scheduled tasks, or gMSA/LsaProtect alternatives), each adding setup complexity outside this probe's scope. `[documented]`
- Credential Manager reads follow the same profile-loading requirement. `[documented]`
- LocalMachine DPAPI scope avoids the profile issue but makes the blob machine-wide — any local account/service can attempt decryption, which violates least privilege for a node identity key unless combined with per-service ACLs. `[documented]` + `[inference]`
- This host currently runs Hermes interactively; no service topology is installed. `[observed]`

Failure-mode summary `[inference]`: the CR-6 service packaging must either (a) ensure profile load for the designated node account, or (b) accept LocalMachine-scope DPAPI plus compensating ACLs, or (c) hold the key only in-memory after an interactive unlock. Fail-closed ordering favors (a).

## 5. Backup / restore / reset / revocation considerations

- **Backup/restore:** DPAPI CurrentUser blobs are backed up with the user profile only through Windows' credential-roaming/domain-backup mechanisms; a file-level copy of blobs without the masterkey backup is useless — good for theft resistance, bad for naive backups. `[documented]`
- **Account reset:** password reset by another party destroys DPAPI masterkeys unless a recovery key was exported; stored secrets become permanently undecryptable (fail-closed, but means re-enrollment). `[documented]`
- **Roaming:** on a non-domain Home-edition machine there is no roaming-profile path; keys are strictly local to RIG1 + this account. `[documented]` + `[observed]` (edition)
- **Encryption at rest:** both DPAPI and Credential Manager encrypt at rest keyed to the account; BitLocker device encryption additionally present at the volume layer on this class of hardware. `[documented]`
- **Revocation:** deleting a Credential Manager entry or DPAPI blob is immediate and total; there is no grace window to worry about locally. Server-side revocation of the node key (per CR-5A retired/revoked key state) remains the authoritative kill switch. `[documented]` + `[inference]`
- **Local journal co-location:** the SQLite journal (CR-5B) must never store private keys (already enforced by its secret-material guard); co-locating journal DB and key store on disk is therefore acceptable — compromise of one does not expose key material. `[documented]` (CR-5B contract)

## 6. Recommendation

Ranked by minimum dependencies first, fail-closed behavior second:

**Recommendation: Route A (PowerShell-child DPAPI, CurrentUser scope, optional entropy) as the v1 `NodeKeyStore` Windows implementation, with Route B (native addon) as a documented performance upgrade path.**

1. **v1: DPAPI CurrentUser via PowerShell child.**
   - Zero new dependencies; everything observed works today on Node 22 / PS 5.1. `[observed]`
   - Use pattern: unlock once at bridge start → hold Ed25519 private key in process memory → never call the store per frame. The ~416 ms/op cost is irrelevant at boot. `[observed]` + `[inference]`
   - Add caller-supplied entropy derived from a machine-local non-secret file so blobs are not portable between clones of the same profile. `[inference]`
   - Fails closed: wrong user, reset profile, or missing masterkey ⇒ decrypt throws ⇒ bridge refuses to authenticate. `[documented]`
2. **CR-6 prerequisite:** whichever service supervisor packages the bridge must guarantee the node account's profile is loaded before the store unlocks; document this as a hard deployment requirement, not a runtime fallback. `[inference]`
3. **Later: swap in a small N-API addon (`@primno/dpapi`-class)** behind the same interface if per-operation latency ever matters; interface stays identical so it is a drop-in. `[documented]`
4. **Not recommended:** LocalMachine scope (over-broad trust) and TPM/NCrypt (elevation + native complexity disproportionate to threat model for v1). `[inference]`

### Proposed capability descriptor

```jsonc
// windows-dpapi-user capability descriptor (proposal, not implemented here)
{
  "id": "windows-dpapi-currentuser",
  "binding": "user",                 // CurrentUser scope; fails closed across accounts/resets
  "scope": "machine-local",          // no roaming on Home edition
  "dependencies": ["windows-powershell-51"], // zero additional installs
  "latency_class": "boot-unlock",    // not suitable per-operation
  "service_mode": "requires-loaded-user-profile",
  "entropy": "optional-caller-supplied",
  "backup": "profile-bound; export recovery key separately",
  "fail_behavior": "throw-on-unlock-failure"
}
```

### Test strategy proposal

1. Unit (CI-safe, no persistence): protect/unprotect round-trip of constants; entropy mismatch rejection; wrong-scope rejection.
2. Integration (manual, per-machine): restart persistence; second-account denial; profile-not-loaded simulation via `schtasks` dry-run definition (definition only, never registered).
3. Bridge-level: unlock-at-start wiring; fail-closed when store returns error; memory-only retention verified by absence of plaintext writes.
4. All test vectors are constants; no production material, no Credential Manager writes, no scheduled-task registration — matching this packet's constraints.

## Acceptance self-checks

- `git diff --check`: clean (run before PR). ✔
- No secret values, usernames, SIDs, or personal paths in this report: machine name, account names, and vault entry names deliberately redacted. ✔
- Claim markers used throughout: `[observed]` / `[documented]` / `[inference]`. ✔
- Forbidden effects honored: no persistent test secrets, no registry/task/service/admin/network effects beyond GitHub API access itself. ✔

## Probe artifacts

- `scripts/probes/windows-keystore-probe.ps1` — PowerShell-side DPAPI/CredReadW/cert-store/TPM metadata probe (dry-run).
- `scripts/probes/windows-keystore-node-probe.cjs` — Node 22 → PowerShell child round-trip with latency measurement (dry-run).
