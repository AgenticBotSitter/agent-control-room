# CR-5C.9 real-host qualification packets

**Status:** Retired historical packet text — do not dispatch or reuse

Replacement contracts are defined in `docs/CR5C9_QUALIFICATION_PACKETS_V1.md` and `docs/qualification-packets/CR5C9Q_*_V1.json` for reserved issues #86–#88. Only the exact validated JSON embedded in those issues is dispatch authority.

These packets predate `control-room-work-packet/v1` and are not executable contracts. Their prose combined one-item cardinality with multiple fault cases, omitted setup/helper/download budgets, did not state whether fixtures must be reused, and left retry/diagnostic behavior implicit. That ambiguity contributed directly to authorization deviations on all three hosts. The resulting reports remain research evidence, but these packet definitions must not be used for re-qualification.

Any replacement packet must include a validated execution-contract JSON and digest, explicitly map every test case to effect IDs, state whether one artifact is mutated/restored or multiple artifacts are authorized, and stop on the first unbudgeted failure. Author the replacement through `.github/ISSUE_TEMPLATE/hermes-work-packet.yml` and the `control-room-work-packets` execution-contract reference.

These are qualification tasks, not implementation authority. Each worker must use a disposable Ed25519 key generated for this rehearsal, reveal no private bytes or secret values, avoid production identity material, and delete every disposable artifact it creates. Reports may contain safe states, timings, command/tool versions, hashes of public data, and redacted paths only.

Every report must distinguish `observed`, `documented`, and `inference`; state every side effect; include exact repository commit; run the repository test/check/lint gates; and stop without changing provider contracts. If a host cannot satisfy a step safely, record the blocked evidence rather than weakening the step.

## Packet A — Marvin / macOS M4 Pro / Keychain

**Goal:** Prove that the adapter can retrieve and use one disposable generic-password item from the actual Hermes/LaunchAgent context, then fail closed in unavailable contexts.

1. Inspect `MacOsKeychainNodePrivateKeyStore` and its tests before acting.
2. Create one disposable Keychain generic-password item using a Security-framework helper that reads PKCS#8 from stdin or memory. Do not use a CLI form that places PKCS#8 in argv, a file, shell history, logs, or the report.
3. Store base64 PKCS#8 under a unique disposable service/account, instantiate the real adapter with those references, unlock, sign a constant challenge, and verify using only the disposable public key.
4. Confirm the adapter invocation contains service/account metadata but no private material.
5. Exercise metadata availability, missing-item mapping, lock/sign refusal, and delete the item.
6. If safely possible without modifying production services, test a locked Keychain or non-GUI/SSH context and record whether it maps to `locked` or `interaction_required`. Do not bypass a prompt or alter Keychain policy.
7. Record whether a rebuilt helper/Node process prompts because of item ACL/code-signing identity. If this cannot be tested safely, keep it open.
8. Deliver only `docs/hermes-reviews/CR5C9_MACOS_KEYCHAIN_QUALIFICATION.md` in a PR. No provider-code change.

**Must pass:** disposable sign/verify, cleanup verified, no secret in arguments/files/logs/report, fixed safe errors only.

## Packet B — Ziggy / Windows 11 / DPAPI CurrentUser

**Goal:** Prove DPAPI boot unlock under the actual interactive Hermes account and characterize the profile-loaded boundary.

1. Inspect `WindowsDpapiNodePrivateKeyStore`, the fixed PowerShell script, and its tests.
2. Generate one disposable Ed25519 key in memory. Use a separate disposable PowerShell helper that reads PKCS#8 from stdin and returns only a CurrentUser DPAPI blob; do not use LocalMachine scope.
3. Write only the DPAPI ciphertext blob to a temporary owner-controlled file. Instantiate the real blob loader and adapter, unlock once, sign a constant challenge, and verify with the disposable public key.
4. Confirm private material appears in neither PowerShell arguments, blob file, repository, logs, nor report. Record boot-unlock latency.
5. Exercise ciphertext tamper, missing blob, lock/sign refusal, and wrong entropy. All must fail closed without trying another provider.
6. If it can be done without registering a service/task or changing machine configuration, run from a profile-unavailable disposable context. Otherwise document this as a CR-6 packaging gate; do not use LocalMachine as a workaround.
7. Delete the blob and every temporary artifact and verify removal.
8. Deliver only `docs/hermes-reviews/CR5C9_WINDOWS_DPAPI_QUALIFICATION.md` in a PR. No provider-code change.

**Must pass:** CurrentUser sign/verify, stdin-only plaintext transport, tamper refusal, cleanup, no fallback.

## Packet C — Johnny5 / headless Linux VPS / encrypted file

**Goal:** Prove the portable provider in the real container posture with owner-only files and an inherited descriptor.

1. Inspect `EncryptedFileNodePrivateKeyStore`, `ProtectedJsonEnvelopeFile`, `ProtectedFileUnwrapSecretSource`, and `FileDescriptorUnwrapSecretSource`.
2. Generate a disposable Ed25519 key and 32-byte wrap key in memory; seal with `sealEncryptedPrivateKey`.
3. In a disposable directory, create the envelope and protected wrap-secret files with directory mode `0700`, files `0600`, and the current process owner. Never commit or report their contents.
4. Unlock/sign/verify with protected-file mode. Then repeat in a fresh process with the wrap secret delivered through an inherited descriptor, not an environment variable or argument.
5. Exercise tag tamper, wrap-key mismatch, mode drift, owner drift if safely possible, symlink substitution, missing secret, descriptor length 31/33, and container restart/relaunch. Each must fail closed and must not regenerate.
6. Record container runtime, UID, file modes, public fingerprint, and safe result categories only.
7. Delete all disposable files/directories and verify cleanup.
8. Deliver only `docs/hermes-reviews/CR5C9_LINUX_ENCRYPTED_FILE_QUALIFICATION.md` in a PR. No provider-code change.

**Must pass:** both secret-source modes, restart unlock, permission/tamper refusal, cleanup, no secret in environment/argv/report.

## Codex review and merge rule

The three PRs remain unmerged until Codex checks them against the same provider commit. A report that proposes code changes, weakens a denial, uses a production key, leaks a secret transport, or substitutes documentation for a required observation is rejected with notes. Accepted reports are documentation evidence only; any necessary provider fix becomes a separate bounded implementation block followed by rerunning all affected host packets.

