# CR-5C.9H pinned platform-key-store qualification harnesses

Status: architect implementation and local Windows rehearsal. This block replaces worker-authored, scratch-relative qualification programs with repository-owned execute-only harnesses.

## Boundary

The committed entry point is `scripts/qualification/platform-key-store-harness.ts`. It imports `createNodePrivateKeyStore` from the pinned repository source and exercises the selected production provider through that factory. Workers must not copy provider logic, write a substitute harness, change imports, or repair a failure on the target host.

The macOS fixture helper source is committed at `scripts/qualification/macos-keychain-fixture.swift`. It accepts only the exact disposable service/account identifiers in argv and receives the base64 PKCS#8 value through stdin. It never supports `Always Allow` or a persistent permission change.

## Invocation

The architect packet supplies an immutable commit, one newly created empty direct child of the OS temporary directory with a `control-room-cr5c9h-` prefix, and the exact command.

```text
pnpm qualify:keystore -- --platform windows --scratch <exact-empty-temp-child>
pnpm qualify:keystore -- --platform linux --scratch <exact-empty-temp-child>
pnpm qualify:keystore -- --platform macos --scratch <exact-empty-temp-child> --service <packet-id> --account <packet-id>
```

The harness refuses the wrong runtime platform, relative/noncanonical scratch paths, symlink/reparse scratch targets, non-direct temp children, unexpected prefixes, foreign ownership where UID evidence exists, and nonempty scratch directories. It emits one compact JSON result containing categorical cases, counts, a public-key fingerprint, and relative cleanup targets. Raw native diagnostics, private values, ciphertext, absolute scratch paths, account/host identity, and tokens are not emitted.

## Platform coverage

### Windows

- provisions one CurrentUser DPAPI blob using plaintext only on stdin;
- writes one valid and one tampered ciphertext file;
- creates every store through the real factory;
- performs exactly three real provider unprotect attempts: valid, tampered, and wrong entropy;
- proves Ed25519 sign/verify, lock/sign refusal, missing-file availability, argv boundaries, and no fallback.

### Linux

- seals one envelope with the repository implementation;
- creates stores through the real factory with protected-file and inherited-descriptor sources;
- proves protected-file and one fresh-child inherited-FD sign/verify;
- proves tag, wrong-key, mode, symlink, missing, and exact 31/33-byte refusals;
- labels a fresh child as process evidence only, never container/host restart evidence.

### macOS

- compiles only the committed Security-framework fixture helper;
- creates exactly one disposable generic-password item with the secret on stdin;
- creates the store through the real factory;
- proves metadata availability, operator `Allow Once` unlock, Ed25519 sign/verify, lock/sign refusal, missing mapping, and argv boundaries;
- deletes the exact disposable item before reporting success; helper binary cleanup remains part of the exact scratch cleanup.

## Dispatch rule

No real-host packet may be issued until the harness commit passes TypeScript, lint, deterministic safety tests, the local Windows real-host test, and independent read-only contradiction review. Platform workers receive execute-only contracts: one pinned command, one attempt, one scratch root, enumerated output targets, exact cleanup, and no harness editing or retry authority.

A launch/module-resolution failure consumes the harness occurrence. A provider failure consumes the relevant provider occurrence. Either path runs only contracted cleanup and stops. Review repairs require a separately budgeted report-repair effect or a new packet; they are never inferred.
