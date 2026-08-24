# CR-5C.9 validated real-host qualification packets v1

**Status:** Architect-authored and validator-ready for issues #86–#88  
**Provider and contract-schema base:** `7375d4c7e042ada2b404b8590b5547f58044cc11`
**Authority:** The exact JSON contract embedded in each GitHub issue controls execution. This document explains the required method but cannot widen a contract.

## Why these replace the historical packets

The retired packet prose did not budget setup, failed attempts, helpers, diagnostics, cleanup, or the number of disposable artifacts needed by multiple negative cases. These replacements permit one attempt only, enumerate every mutable/external action, give every disposable artifact a separately budgeted cleanup effect, and require contract/actual-ledger validation before handoff.

The qualification worker does not repair code, install tools, create a second fixture, or reinterpret an ambiguous count. A missing prerequisite produces `CONTRACT BLOCKED` before branch creation or host mutation. A failure after artifact creation performs only the attached cleanup effects and stops.

## Shared preflight and report contract

Before any write, each worker must:

1. read its entire issue and check for an existing claim, branch, or PR;
2. confirm the checkout is clean at the exact provider base;
3. confirm every required runtime/tool already exists without installing, downloading, updating, or reconfiguring it;
4. pass the issue JSON to `validate_execution_contract.py` through stdin or memory and reproduce the issue digest;
5. walk the worst-case table below and post one combined `CONTRACT READY` acknowledgement. A mismatch produces `CONTRACT BLOCKED` and no other effect.

The one harness must perform all platform cases in one execution. Its safe result object may contain categorical outcomes, durations, public-key fingerprints, tool versions, and redacted platform context. It must not contain private bytes, wrap secrets, DPAPI/Keychain/envelope ciphertext, personal paths, raw host/account identity, or raw native diagnostics.

The report must include:

- issue, packet ID, exact base/head/branch, real worker/harness/model, and contract digest;
- the preflight acknowledgement and pre-existing tool versions;
- one row per required case labeled `observed`, `blocked`, or `deferred by architecture`;
- chronological planned-versus-actual effects, including zero-count optional effects and every cleanup;
- exact cleanup proof and actual-ledger validator result;
- exact scope/diff gate results;
- a single disposition: `met`, `partial/blocked`, `not met`, or `rejected — authorization deviation`.

No author or helper model may independently accept the report. No worker may merge or approve its own PR.

## Packet A — macOS Keychain / issue #86

Contract: `docs/qualification-packets/CR5C9Q_MACOS_KEYCHAIN_V1.json`  
Digest: `c0742f563b9fe20f590b19be85e4a466dd23b89d18f77d6dcb841569115ac50e`
Worker/branch: Marvin / `worker/marvin/86-macos-keychain-requalification`

Required pre-existing tools: Python 3, Node 22+, installed repository dependencies/`tsx`, `swiftc`, Security.framework, `/usr/bin/security`, Git, authenticated GitHub tooling, and the ordinary interactive Hermes/LaunchAgent Keychain context. Missing any item blocks before writes.

The packet uses one scratch tree, one compiled Security-framework helper, one harness, one disposable in-memory Ed25519 keypair, and one exact generic-password item. The helper accepts PKCS#8 only through stdin/memory. It is compiled once, invoked once to add the item, and the separately counted cleanup effect invokes the exact-item delete path. The adapter performs exactly three native calls: metadata availability, unlock, and post-delete missing verification. Lock/sign refusal and Ed25519 verification occur in process. One native `Allow once` response is permitted only if the exact disposable item prompts; `Always Allow` and ACL/policy edits are forbidden.

Locked-login-Keychain, SSH/non-GUI, rebuilt-helper identity drift, and persistent service context are not attempted in this block. They are explicit CR-6A service-packaging gates, not passing observations.

Worst-case maxima: `E-GIT=2`, `E-GITHUB-READ=6`, `E-GITHUB-WRITE=4`, `E-CONTRACT-VALIDATOR=2`, `E-SCOPE-VALIDATOR=1`, `E-MAC-KEY=1`, `E-MAC-SCRATCH=1`, `E-MAC-SCRATCH-CLEANUP=1`, `E-MAC-HELPER=2`, `E-MAC-HARNESS=1`, `E-MAC-ITEM=1`, `E-MAC-ITEM-CLEANUP=1`, `E-MAC-ADAPTER=3`, `E-MAC-PROMPT=1`, `E-REPORT=1`.

## Packet B — Windows DPAPI CurrentUser / issue #87

Contract: `docs/qualification-packets/CR5C9Q_WINDOWS_DPAPI_V1.json`  
Packet revision: `CR-5C.9-Q-windows-dpapi-v2` (adds an exact stale-clone bootstrap fetch and canonical-digest instructions)
Digest: `a1ccc72c5bf478ec8b12964b2e3edd43ec65527e95e15ad92be0e17163fbc04e`
Worker/branch: Ziggy / `worker/ziggy/87-windows-dpapi-requalification`

Required pre-existing tools: Python 3, Node 22+, installed repository dependencies/`tsx`, Windows PowerShell at the provider's fixed path, .NET `System.Security`, Git, authenticated GitHub tooling, and the ordinary interactive Hermes account with its CurrentUser profile loaded. Missing any item blocks before writes.

The packet uses one scratch tree, one harness, one in-memory Ed25519 keypair, one non-secret entropy value, one PowerShell protection call, one valid ciphertext file, and one tampered ciphertext file. The real provider performs exactly three unprotect calls: valid, tampered, and wrong entropy. Missing-file availability and lock/sign refusal do not invoke DPAPI. The report records stdin/argv boundary evidence and safe categories only. LocalMachine, another account, and fallback providers are forbidden.

Profile-unavailable service/task execution is not attempted. It requires service packaging and is an explicit CR-6A gate.

Worst-case maxima: `E-GIT=2`, `E-GITHUB-READ=6`, `E-GITHUB-WRITE=4`, `E-CONTRACT-VALIDATOR=2`, `E-SCOPE-VALIDATOR=1`, `E-WIN-KEY=1`, `E-WIN-SCRATCH=1`, `E-WIN-SCRATCH-CLEANUP=1`, `E-WIN-HARNESS=1`, `E-WIN-PROTECT=1`, `E-WIN-ADAPTER=3`, `E-REPORT=1`.

## Packet C — Linux encrypted file / issue #88

Contract: `docs/qualification-packets/CR5C9Q_LINUX_ENCRYPTED_FILE_V1.json`  
Digest: `63af12ff3bf270dd6186496966589a2bf2d0d77f448ffb40ab65520fd5f63390`
Worker/branch: Johnny5 / `worker/johnny5/88-linux-encrypted-file-requalification`

Required pre-existing tools: Python 3, Node 22+, installed repository dependencies/`tsx`, POSIX mode/symlink support, inherited file descriptors, Git, and authenticated GitHub tooling. The existing checkout and runtime must already satisfy these requirements; downloading a Node tarball or dependencies is forbidden.

The packet uses one 0700 scratch tree, one harness, one Ed25519 keypair, one 32-byte wrap key, a one-byte-mutated in-memory mismatch copy, fixed valid/tampered envelope files, one 0600 wrap file, fixed 31/33-byte descriptor fixtures, and one contained symlink. The parent harness runs once and spawns one fresh Node child with the wrap secret on one inherited descriptor. It exercises protected-file and inherited-descriptor sign/verify plus tag, wrong-key, mode, symlink, missing, and descriptor-length refusal without regeneration.

Changing ownership or using another UID is forbidden because the current container reports one root execution identity; that would not prove meaningful cross-UID isolation. Container/host restart, systemd/Docker changes, cgroup/capability/seccomp changes, and service identity are explicit CR-6A gates. This packet proves a fresh process, not a container restart, and the report must use those exact words.

Worst-case maxima: `E-GIT=2`, `E-GITHUB-READ=6`, `E-GITHUB-WRITE=4`, `E-CONTRACT-VALIDATOR=2`, `E-SCOPE-VALIDATOR=1`, `E-LINUX-KEYS=1`, `E-LINUX-SCRATCH=1`, `E-LINUX-SCRATCH-CLEANUP=1`, `E-LINUX-MODE=2`, `E-LINUX-SYMLINK=1`, `E-LINUX-HARNESS=1`, `E-LINUX-CHILD=1`, `E-REPORT=1`.

## Architect review and CR-5C close rule

Codex reviews each PR against its immutable issue contract and original digest. Scope is checked first, then effect chronology, cleanup, native evidence, claim labels, and consistency between issue, report, PR body, and head. A technically successful run with an unknown or over-budget effect is rejected.

CR-5C.9 closes when all three interactive/runtime provider paths pass these packets. The explicitly deferred service identity, alternate-principal, sleep/reboot/container restart, and native supervisor behaviors remain named CR-6A gates and may not be described as completed.
