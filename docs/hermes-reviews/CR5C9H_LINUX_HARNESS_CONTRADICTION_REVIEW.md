# CR-5C.9H-R Linux harness contradiction review (Johnny5)

**Disposition / recommendation:** `accept` — PR #94 at pinned head `1aea4d8f43157af0f6344c8998f2568f108aa1d6` is internally consistent, correctly scoped to repository-owned execute-only harnesses, and free of contradictions with the provider contracts. No merge authority is claimed; this review does not close any host-qualification gate.

## Header

- **Issue:** #96 (CR-5C.9H-R) · packet `CR-5C.9H-R-linux-v1` · authors Codex/Sol (independence gate: reviewer Johnny5 is not an excluded author; no overlap with PR #94 authorship)
- **Reviewed head:** PR #94 @ `1aea4d8f43157af0f6344c8998f2568f108aa1d6`, fetched exactly once (`E-GIT-SYNC`), ref verified equal to the pinned head
- **Review class:** strictly read-only contradiction review; no harness, Swift helper, DPAPI, Keychain, encrypted-file provider, key generation, or host probe executed
- **Changed paths reviewed:** `docs/BUILD_STATUS.md`, `docs/CR5C9H_PINNED_QUALIFICATION_HARNESSES.md`, `docs/CR5C9_PLATFORM_KEY_PROVIDERS.md`, `package.json`, `scripts/qualification/macos-keychain-fixture.swift`, `scripts/qualification/platform-key-store-harness.ts`, `tests/node-platform-qualification-harness.test.ts`

## Scope check

The diff touches exactly the seven files listed in the PR; all are harness/docs/test/script files consistent with "repository-owned execute-only harnesses". No provider source under `src/node-policy/v1/` was modified — verified by reading the diff; the encrypted-file and native-store providers cited below are pre-existing code at the pinned head.

## Static gates

| Gate | Command | Exit | Notes |
|---|---|---|---|
| pnpm check | `tsc --noEmit` over the pinned tree | 0 | pass |
| pnpm lint | `eslint . --ignore-pattern dist --ignore-pattern .next` | 0 | pass; one benign warning: the `.swift` file has no matching ESLint config (file ignored) |

No test suite or qualification harness was executed. Dependencies were preexisting on the host; none were installed for this review.

## Assigned focus findings

### 1. Real factory/provider execution in parent and child

**Source facts `[observed in source at 1aea4d8]`:**
- Both parent paths construct stores through the real factory `createNodePrivateKeyStore` (`private-key-store-factory.ts:35-66`), which enforces platform/provider selection (`selectNodePrivateKeyProvider`) and rejects cross-platform execution with `unavailable_platform`. The Linux parent uses provider `encrypted_file` + `protected_file` source (`platform-key-store-harness.ts:339-347`); the fresh child re-enters through the same factory with `file_descriptor` (`:264-273`). The Windows path goes through `WindowsDpapiNodePrivateKeyStore.loadPkcs8` → real PowerShell `-EncodedCommand` invocation (`native-key-stores.ts:257-291`); macOS through `/usr/bin/security find-generic-password` (`native-key-stores.ts:148-152`).
- Signatures are verified against the generated public key with `crypto.verify` (`harness :201, :351, :360`), so a fake signer cannot pass.
- A pinning test asserts the harness imports from `../../src/node-policy/v1/index.ts` and matches `createNodePrivateKeyStore` (`tests/node-platform-qualification-harness.test.ts:31-33`), guarding against regression to native-key-stores internals.

**Platform inference (not observed here):** whether DPAPI/Keychain actually succeed can only be proven on those hosts by the future execute-only qualifications; nothing in the harness fakes them (no mock runner is used for the adapter calls — `NodeSafeCommandRunner` is the inner runner of `AuditedRunner`, `harness :130`).

### 2. fd inheritance, environment, and child module resolution

- Exactly one inherited descriptor: `stdio: ["ignore","pipe","pipe", handle.fd]` with fd 3 opened read-only on the wrap file before spawn (`harness :283-290, :356-357`). No secret appears in child argv (`--linux-child --envelope <path>` only) or environment (`env` limited to PATH/NODE_ENV, `:287`).
- Child output is bounded (8 KiB cap kills the child, `:299-303`); stdout carries base64url signature only; stderr is drained but never echoed (`:304`).
- Module resolution: the child is spawned as `process.execPath --import tsx <scriptPath>` with `cwd` = repo root (`:285-287`), so tsx resolves the TypeScript harness identically to the parent. This is correct for the repo's pinned toolchain but is a documented dependency on `tsx` being resolvable from the repo root — acceptable since dependencies are preexisting-only.
- The child's `FileDescriptorUnwrapSecretSource(3)` enforces fd ≥ 3 and exact 32-byte reads (`encrypted-file-key-store.ts:284-318`), matching the parent's single-descriptor contract.

### 3. Mode/symlink/missing/31–33-byte refusal semantics

Cross-checked harness expectations against provider behavior:
- `safeOpen` (`encrypted-file-key-store.ts:152-184`) rejects non-regular files and symlinks via `lstat` (`:161`), enforces owner-only mode `(mode & 0o077) === 0` plus UID match on POSIX (`:163-164`), and re-verifies dev/ino/mode after open against TOCTOU (`:172-174`). This backs the harness's `mode_drift_refusal` (expects availability `permission_denied` after chmod 0644, restored in a `finally`, `harness :386-391`) and `symlink_refusal` (`:392`). Consistent — no contradiction.
- Missing secret: `safeOpen` maps ENOENT → `missing` (`:157-158`); harness asserts availability state `missing` directly on the source (`:393-396`). Consistent.
- Length refusals: descriptor source requires exactly 32 bytes read (`:302-306`); harness opens 31- and 33-byte fixtures and expects `invalid_configuration` from `source.read()` (`:398-407`). Consistent. Note the read buffer is 33 bytes so a 32-byte read followed by EOF yields bytesRead 32; both off-size fixtures fail.
- Tamper/wrong-key: GCM tag flip and one-byte-changed wrap key both expect `corrupt` at unlock (`:384-385`), consistent with AES-256-GCM auth failure surfacing as `corrupt` through the envelope loader chain.

### 4. Artifact cardinality and exact cleanup inventory

- Linux result declares counts `{keypairs:1, wrapKeys:1, childProcesses:1, harnessRuns:1, scratchFiles:6, scratchSymlinks:1}` (`:417`). Counting fixture writes: envelope, tampered envelope, wrap, wrong-wrap, 31-, 33-byte = **6 files**, plus 1 symlink (`:331-337`). Consistent.
- `cleanupTargets` lists all 7 scratch artifacts (`:419`): 6 files + `wrap-link.key`. Complete — no orphan. The symlink points inside the same scratch tree, so root cleanup owns it without traversal.
- Windows counts `{scratchFiles:2}` vs writes `dpapi-valid.bin` + `dpapi-tampered.bin` (`:182-183`); cleanupTargets match (`:251`). The missing-blob path is intentionally never created (`missingPath` referenced but never written, `:150/:225-233`) — correct, since the missing case must observe absence. Consistent.
- macOS cleanup covers both the compiled helper binary and the keychain item, including best-effort deletion on failure with `itemCreated` tracking (`:482-494, :522-537`). Consistent.
- Scratch admission control: `requireScratch` (`:110-125`) requires absolute path, realpath equality, directory-not-symlink, direct child of the OS temp root, `control-room-cr5c9h-*` name, UID match, and **empty directory** — enforcing cardinality before any effect. Tested by the nonempty-scratch and unknown-arg fail-closed tests.

## Contradiction scan

- `docs/CR5C9_PLATFORM_KEY_PROVIDERS.md` status change honestly records that packets #86–#88 did not close the gate (macOS exceeded authority, Windows exhausted its attempt pre-provider, Linux lacked real-provider proof). This aligns with the historical record and with my own prior report's rejection; no contradiction found.
- No claim in the new docs asserts host qualification has occurred; the docs explicitly route locked-Keychain, service-profile, alternate-principal, and restart behaviors to CR-6A. Correct distinction maintained.
- Error taxonomy is safe categories only (`ProtectedStoreError.code` or fixed literals); raw OS errors are never emitted. The error path emits one JSON object with schema + category (`:588-594`). No secret material can reach stdout/stderr through audited paths (buffers zeroed after use, `:175-177, :450-452, :488-492`).

## Minor observations (non-blocking)

1. `spawnLinuxChild` maps any spawn failure to `unavailable_platform` (`:293-297`) — a genuine child crash would be reported as platform unavailability rather than a distinct category. Acceptable for execute-only use; noted for CR-6A packaging.
2. The macOS allow-once window is signaled only via stderr text (`:475`); interactive prompt handling remains an operator concern, correctly outside the harness.
3. `adapter_invocation_count` hard-codes 3 for Windows/macOS (`:239, :505`); if provider call patterns change, these assertions will fail loudly rather than silently pass — acceptable pinning behavior.

## Effect ledger (this review)

All effects within worst-case budget: E-GIT-SYNC=1 (one fetch, head verified), E-GIT=1 so far (branch; report commit next), E-GITHUB-READ=4, E-GITHUB-WRITE=1 (CONTRACT READY), E-CONTRACT-VALIDATOR=2 (preflight + actual-ledger, both ok=true), E-STATIC-CHECK=2 (check+lint, both exit 0), E-REVIEW-SCRATCH=1 (two named JSON files only), E-REVIEW-SCRATCH-CLEANUP=1 (validated then removed, absence verified), E-SCOPE-VALIDATOR=1, E-REPORT=1. Zero harness executions, zero probes, zero installs/downloads.

## Cross-report close recommendation

- Gates satisfied by this review: static checks, contradiction scan, scope/cleanup/cardinality verification, secret-transport audit of the harness source.
- Gates still open: actual host qualification for all three platforms awaits fresh execute-only runs using this harness after #94 merges; macOS (#95) and Windows/cross-platform (#97) reviews are sibling inputs.
- Recommendation to the architect: proceed to review/merge #94; no repairs required from this reviewer's scope.
