# CR-5C.9 platform private-key providers

**Status:** Implementation complete; three real-host qualification packets remain open

**Scope:** Explicit provider construction, memory-only Ed25519 signing, macOS Keychain retrieval, Windows DPAPI CurrentUser retrieval, portable AES-256-GCM envelopes, protected unwrap-secret sources, and safe OS process boundaries

## Delivered boundary

All providers implement the existing `NodePrivateKeyStore` contract. A shared base imports PKCS#8 only inside the store, holds a Node `KeyObject` while unlocked, signs without exposing private bytes, clears transient byte buffers, and drops the active key on lock or disposal.

`createNodePrivateKeyStore` compares configured platform to the real runtime platform and calls the frozen explicit selector. It constructs exactly one configured provider and rejects missing, extra, or mismatched dependencies. It never probes for another provider and never falls back after native failure. The deterministic memory store remains a test-only fixture and cannot be produced by the production factory.

## Providers

### macOS Keychain

`MacOsKeychainNodePrivateKeyStore` addresses one generic-password item by bounded service and account identifiers. Availability performs a metadata-only `security find-generic-password`; unlock adds `-w`, decodes the stored base64 PKCS#8 once, and then signs in process. The executable is invoked directly with `shell: false`. No key value is placed in an argument. Fixed OSStatus/exit evidence maps to `missing`, `interaction_required`, `locked`, or `permission_denied`; raw diagnostics never cross the store boundary.

This adapter intentionally does not provision a Keychain item. The `security add-generic-password -w` CLI would place the secret in process arguments. Enrollment must use an owner-approved Security-framework helper or future native binding that accepts private material through memory/stdin without an argument leak.

### Windows DPAPI CurrentUser

`WindowsDpapiNodePrivateKeyStore` reads a bounded opaque DPAPI blob, sends that ciphertext and optional non-secret entropy to Windows PowerShell over stdin, and invokes a fixed encoded script with CurrentUser scope. The script returns base64 PKCS#8 only over stdout. A failed unprotect maps to `locked`; the adapter never tries LocalMachine scope, another account, or encrypted-file mode.

The blob loader rejects symlinks, changes between inspection/open, and unreasonable sizes. The blob is already DPAPI ciphertext; private key bytes are never stored there. A service deployment still has to prove that the designated account profile is loaded.

### Encrypted file

`EncryptedFileNodePrivateKeyStore` authenticates a strict AES-256-GCM envelope bound by AAD to key ID, reference ID, algorithm, schema, and cipher. Unknown fields, identity drift, the wrong unwrap key, tag changes, malformed lengths, and a non-Ed25519 plaintext fail closed.

The unwrap secret is exactly 32 bytes and comes from one explicitly selected source:

- a protected owner-only file on POSIX, opened only after symlink/type/owner/mode checks and revalidated after open;
- a one-shot inherited file descriptor; or
- an injected platform-secret facility.

Windows protected-file mode remains unavailable because POSIX mode bits cannot prove a Windows ACL. Windows may use an inherited descriptor or a separately qualified platform-secret reader. Environment variables and command-line arguments are not implemented as secret sources.

Envelope sealing is a pure enrollment helper. File creation, overwrite, permission changes, backup, and secret delivery remain operator/deployment effects outside the runtime factory.

## Safe subprocess boundary

`NodeSafeCommandRunner` uses `spawn` without a shell, hides Windows process windows, bounds time and combined output, kills on overflow/timeout, and returns only byte buffers to the provider. Providers clear stdout, stderr, stdin payload, ciphertext, entropy, wrapping-key copies, and decrypted PKCS#8 buffers after use. Raw child-process errors become fixed `ProtectedStoreError` categories.

JavaScript and Node cannot guarantee immediate zeroization of `KeyObject` internals or immutable strings. The honest guarantee is no application-level persistence or observability of private bytes and best-effort clearing of mutable transient buffers. Same-account process compromise remains outside this in-process boundary and is reduced later through CR-6 service isolation.

## Automated verification

`tests/node-platform-key-stores.test.ts` covers exact envelope binding, tag/key/schema drift, lock/sign/dispose lifecycle, one-shot file descriptors, Windows ACL refusal, Keychain command shape and safe failure mapping, DPAPI stdin/argument separation, provider/platform/dependency mismatch, and refusal to downgrade. Every native command is replaced by a deterministic runner in CI; the tests never touch a real OS key store.

## Completion gate

CR-5C.9 and CR-5C remain open until all three packets in `docs/CR5C9_MANUAL_QUALIFICATION_PACKETS.md` return evidence and Codex reviews it. CI does not substitute for Keychain ACL/prompt context, DPAPI profile loading, Linux container file ownership, or restart behavior.
