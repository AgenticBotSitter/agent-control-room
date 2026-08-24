# CR-5C.2 protected-store and clock contracts

**Status:** Implemented
**Date:** 2026-08-23
**Normative parent:** `CR5C_FINAL_SECURITY_CONTRACT.md`, ADR-024, ADR-025, and ADR-031
**Scope:** Authority interfaces, explicit provider selection, safe errors, deterministic test doubles, and the CR-5B signing adapter

## Outcome

CR-5C.2 separates four responsibilities before any stateful node-security code depends on them:

1. `NodePrivateKeyStore` signs bytes without returning private-key bytes.
2. `ServerTrustStore` resolves online server public keys and accepts owner-signed trust bundles.
3. `ApprovalTrustStore` resolves the separate public keys that can authorize owner approval attestations.
4. `Clock` supplies policy time without a policy function reading wall time internally.

The node bridge can now sign protocol frames through `ProtectedStoreFrameSigner`. The adapter checks that the frame's claimed key ID matches the store's opaque reference, computes the canonical frame material, delegates only the byte-signing operation, and rejects a non-Ed25519-length result. The bridge and journal never receive private-key material.

## Opaque references and availability

`KeyReferenceV1` contains only contract version, key ID, opaque reference ID, provider, mode, and public algorithm. It has no extensible metadata, filesystem path, account name, unwrap source value, or secret-bearing field. Its strict validator rejects provider/mode disagreement and unknown fields.

Availability uses the closed CR-5C.1 vocabulary: `available`, `locked`, `interaction_required`, `missing`, `corrupt`, `permission_denied`, and `unavailable_platform`. Store failures use fixed `ProtectedStoreError` codes and messages. Raw OS exceptions, paths, usernames, and verifier errors are not carried as causes or interpolated into messages.

## Provider selection

Provider selection is static and explicit:

- `macos_keychain` is valid only on `darwin`;
- `windows_dpapi_current_user` is valid only on `win32`;
- `encrypted_file` is valid on a supported platform only with an explicit safe unwrap source; and
- `memory_test` is valid only in test mode.

The only representable encrypted-file unwrap sources are `protected_file`, `file_descriptor`, and `platform_secret`. Environment variables and command-line arguments are absent from the type and validator.

There is no fallback option in the selector. A native provider failure remains a failure until the owner explicitly changes deployment configuration. This resolves research decision D7 in favor of no silent downgrade. Linux may explicitly select encrypted-file mode as its primary provider; that is not treated as a fallback.

The research proposal that mentioned environment-variable delivery for the Linux master secret is rejected by the later architect-frozen contract. CR-6 must choose an operator-configured protected file/descriptor or platform secret facility before the Linux provider can be deployed.

## Deterministic test doubles

`src/node-policy/v1/testing.ts` supplies non-production fakes:

- a private-key fake with controlled availability, unlock/sign/lock/dispose behavior, real in-memory Ed25519 signing, and argument-free call history;
- a server-trust fake with an injected bundle verifier, monotonic in-memory epochs, active public-key resolution, and cloned outputs;
- a separately keyed approval-trust fake; and
- a mutable canonical UTC clock.

The fakes are deliberately not exported from the main node-policy barrel. Consumers must import the explicit testing subpath. They do not prove OS key isolation, crash-safe trust adoption, owner-root pin persistence, irreversible revocation, or zeroization of Node `KeyObject` memory. Those are later implementation and rehearsal gates.

## Security invariants proved here

- sign-before-unlock, sign-after-lock, nonavailable stores, and disposed stores fail closed;
- changing availability away from `available` removes the fake's active signer;
- references, availability snapshots, errors, and history contain neither signing input nor private key bytes;
- resolved public-key byte arrays are cloned so a caller cannot mutate store state;
- server and approval trust cannot resolve one another's keys;
- malformed bundles, verifier exceptions, invalid signatures, and epoch rollback become fixed safe errors;
- a bridge frame cannot claim a key ID different from the actual signing store; and
- the injected clock is canonical and deterministic.

## Deliberate stop boundary

CR-5C.2 does not implement:

- macOS Keychain, Windows DPAPI, or encrypted-file providers;
- unwrap-secret delivery;
- a persistent ceiling or trust store;
- owner-root pinning, atomic trust-bundle adoption, high-water recovery, or key reactivation rules;
- authority intersection, expiry monitoring, executor admission, effects, or live integrations.

`DeterministicServerTrustStoreFake` is a consumer-testing fake, not the production trust implementation. CR-5C.3 owns crash-safe monotonic ceiling/trust persistence and must enforce the full owner-root and lifecycle contract.

## Verification

`tests/node-protected-stores.test.ts` covers explicit selection, opaque references, lifecycle failures, secret nonexposure, real Ed25519 bridge signing, key-ID binding, separated trust resolution, cloned public bytes, safe verifier failure, monotonic fake epochs, and clock behavior.

The full repository gate remains `pnpm check`, `pnpm lint`, `pnpm test`, `pnpm db:verify`, and `pnpm test:build`.
