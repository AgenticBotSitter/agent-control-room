# CR-5C macOS protected-key-store capability probe

**Status:** Complete 2026-08-23
**Worker route:** Marvin / macOS M4 Pro (Mac mini) / Hermes / provisional qualification route — executed by a Hermes session on Alastair's Mac mini.
**Task class:** Qualification; low risk; report-only.
**Stop boundary honored:** No Keychain items were created or modified, no access policy changed, no daemon installed, no sudo, no network calls, no live integration. All commands were read-only metadata probes.

## 1. Environment evidence (observed)

| Item | Value | Claim class |
|---|---|---|
| OS | macOS 26.6.2 (Build 25G83), arm64 | observed |
| Machine | Mac mini, Model Identifier `Mac16,11`, Apple M4 Pro | observed |
| Boot policy | Full Security boot, SIP enabled, Signed System Volume enabled, Kernel CTRR enabled | observed |
| Node.js | v22.22.3 at `<home>/.hermes/node/bin/node` | observed |
| Git | 2.50.1 (Apple Git-155) | observed |
| `security` CLI | `/usr/bin/security` present; supports `add-generic-password`, `find-generic-password`, `delete-generic-password`, keychain listing | observed |
| Runtime context | Unprivileged interactive user process under launchd **Aqua (GUI)** domain (`launchctl managername` → `Aqua`, gui/501 login session); parent process is the Hermes agent's Python venv interpreter | observed |
| Node binary signature | Ad-hoc-style CodeSignature present with **hardened runtime flag** (`flags=0x10000(runtime)`), unsigned developer identity (0 valid codesigning identities on machine) | observed |
| Hermes invocation | Hermes Agent session (this report's harness); inference model route recorded in PR metadata per delegation playbook | observed |

## 2. Login-keychain accessibility from this process context

**Observed:**

- The default keychain is the user login keychain at the standard path under the home directory placeholder `<home>/Library/Keychains/login.keychain-db`.
- `security show-keychain-info` succeeds from this non-TTY process and reports `no-timeout`, i.e. the login keychain is currently **unlocked for this session without prompting**.
- A lookup of a nonexistent probe service name returns the clean error `SecKeychainSearchCopyNext: The specified item could not be found in the keychain.` — meaning the Security framework answers queries from this unprivileged background child process without requiring GUI interaction.

**Interpretation (inference):**

- An unprivileged interactive Hermes/Node 22 process *can* query the login keychain today because the login keychain is unlocked with no timeout while the owner is logged in to the Aqua session.
- This is session-dependent, not a guarantee. The same code path run from an SSH session or before first unlock would fail or prompt. See §5.

**Unverified (explicitly):**

- Whether an actual `SecItemAdd` of a test item followed by cross-process reads would trigger an ACL prompt for a differently-signed binary. We did not write any item by packet constraint. This is the single most important follow-up experiment and it requires a disposable machine or explicit owner approval.

## 3. Secure Enclave availability

**Observed:**

- ioreg contains live Secure Enclave driver instances: `AppleSEPBooter`, `AppleSEPCommand`, `AppleSEPCommandPool`, `AppleSEPControl`, `AppleSEPCoreBuffer`, `AppleSEPSharedMemoryChannel`. The SEP is present, booted, and operational.
- `system_profiler SPiBridgeDataType` reports Full Security boot with SIP/SSV/CTRR enabled — the T2-class bridge controller is enforcing boot integrity.

**Documented (Apple platform documentation, not re-derived here):**

- On Apple Silicon Macs the Secure Enclave is always fused into the SoC; keys generated inside it are never exportable.
- Secure Enclave supports P-256 ECDSA signing natively. It does **not** implement Ed25519.

**Inference for Control Room:**

- Non-exportable Ed25519-in-hardware is therefore **not achievable via the Secure Enclave**. Two coherent strategies exist:
  - **A:** keep Ed25519 in software (Node WebCrypto / native crypto) and protect the private-key bytes at rest inside the Keychain as a generic-password secret; or
  - **B:** use a Secure Enclave P-256 identity as the node device key (requires protocol support for ES256/COSE-style signatures, which CR-5A's Ed25519-only authenticator does not currently accept).
- Strategy B means either changing the wire contract or adding a second hardware-bound identity for local attestation only. That is a Codex/Sol architecture decision, not something this probe resolves.

## 4. Viable implementation paths, ranked

1. **Keychain generic-password reference (recommended).** Store the Ed25519 PKCS#8 private-key blob as a generic-password item with a stable service/account naming scheme; read it once at bridge start, hold in memory, sign via Node `crypto.sign('sha512'/'ed25519')`. Pros: zero native dependencies (invocable via `security` CLI subprocess or future thin N-API binding), survives FileVault-independent at-rest encryption, integrates with iCloud Keychain backup if desired. Cons: item ACLs are bound to the creating binary's code signature; an ad-hoc signed Node build may prompt on first access after rebuild. Confidence: high that the API surface exists and works interactively (observed); medium that silent cross-build access holds (unverified).
2. **Keychain key item / Secure Enclave.** Hardware-backed, non-exportable, but P-256-only. Requires CR-5A protocol change to accept ES256 signatures. Highest security ceiling, highest integration cost. Not recommended for CR-5C's first increment.
3. **Encrypted-file fallback.** AES-256-GCM envelope file under `<home>/.config/control-room/`, root key itself stored in the Keychain generic-password store (path 1) so the fallback degrades gracefully when the keychain is available and fails closed when it is not. Useful as the uniform portable shape shared with the Linux/Windows probes.

## 5. Failure modes (documented + reasoned; none reproduced)

| Failure mode | Expected behavior | Verification class |
|---|---|---|
| Locked screen / locked keychain after reboot with password prompt pending | `security` and SecItem calls return `errSecInteractionNotAllowed` (-25293); bridge must fail closed and retry with backoff | kill-boundary rehearsal |
| SSH / non-GUI context | Same error family; no UI prompt can be shown. Observed indirectly: current session is Aqua; sshd sessions historically cannot unlock a user keychain without prior unlock in GUI | manual platform validation |
| LaunchAgent / LaunchDaemon context | LaunchAgent inherits Aqua keychain access; global daemons run as root/System context and see the System keychain instead — wrong trust domain | manual platform validation |
| Backup / restore (Time Machine) | Keychain items restore with the account; note: this machine has **no Time Machine destination configured** (observed), so restore behavior was not exercised | documented |
| Keychain reset / revocation | Item lost permanently; bridge must detect missing key reference and require re-enrollment rather than auto-regenerate (identity immutability per CR-5A §"Key identity fields are immutable") | unit + manual |
| User profile change / account rename | Generic-password references are UID-scoped; a renamed home directory breaks absolute paths but not keychain ACLs; a different macOS user cannot read another's login keychain items even as admin without the other user's password | documented |

## 6. Proposed capability descriptor shape (no production interface code)

```jsonc
// Symbolic shape only — CR-5C owns the real schema.
{
  "platform": "darwin",
  "mode": "keychain-generic-password",     // | "secure-enclave-p256" | "encrypted-file"
  "reference": { "service": "<stable-service-id>", "account": "<node-id>" },
  "availability": "available"             // | "locked" | "interaction-required" | "missing",
  "signAlgorithm": "Ed25519",              // what the descriptor promises to the bridge signer seam
  "nonExportable": false,
  "failClosedOn": ["errSecInteractionNotAllowed", "errSecItemNotFound"]
}
```

This maps onto the existing `BridgeFrameSigner` injection seam described in `docs/CR5B_PORTABLE_NODE_BRIDGE.md` — the bridge core already takes signatures without knowing storage details, so CR-5C only needs to produce conforming descriptors plus one platform factory.

## 7. Recommended CR-5C test strategy

1. **Deterministic unit tests (no real Keychain):** inject a fake capability descriptor + in-memory signer into the bridge core; assert fail-closed behavior on every `availability != "available"` state.
2. **Property tests:** descriptor serialization round-trips; no secret material ever appears in journal/log sinks (reuse CR-5B's central secret-material guard).
3. **Manual platform validation (owner-supervised, disposable VM or approved host):**
   a. create one disposable generic-password item, sign once, delete;
   b. repeat from an SSH session — expect `errSecInteractionNotAllowed`;
   c. lock the keychain mid-run and confirm the bridge transitions to `backing_off` rather than crashing;
   d. rebuild/re-sign the Node binary and observe whether the ACL prompts (informs whether we need a fixed signing identity).
4. **Explicitly out of scope until #17 synthesis:** Windows DPAPI and Linux headless comparisons.

## Assumptions

- The packet's "Marvin / macOS M4 Pro" route refers to this physical machine; executed here accordingly.
- Apple platform documentation statements about SEP/P-256/Ed25519 are cited as documented, not independently verified on-device (verifying them would require generating a real enclave key, which the packet forbids).

## Commands run (all read-only)

`sw_vers`, `uname -m`, `node --version`, `which node`, `security --help` / `security help`,
`sysctl hw.model machdep.cpu.brand_string`, `system_profiler SPiBridgeDataType`,
`system_profiler SPHardwareDataType`, `codesign -dv <node binary>`,
`security find-identity -v -p codesigning`, `security list-keychains`, `security default-keychain`,
`security show-keychain-info`, `launchctl managername`, `launchctl print gui/$(id -u)`,
`fdesetup status`, `tmutil destinationinfo`, `ioreg -l` (SEP instance grep),
`security find-generic-password -s cr5c-probe-nonexistent` (negative lookup),
`node -e` Ed25519 WebCrypto and `crypto.generateKeyPairSync('ed25519')` smoke checks (memory only, nothing persisted).
