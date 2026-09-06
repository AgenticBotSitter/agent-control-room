# E69 — pinned etcd client evaluation

2026-09-06. Local research only; no service, socket, credentials or production data.

## Decision

Do not adopt `etcd3` 1.1.2's high-level unary transaction wrapper unchanged for the
checkpoint transport. Keep etcd itself on the shortlist. Next evaluate the existing
gRPC transport/service bindings with an explicit request cancellation handle and
disabled retries, rather than build a storage engine or fork the high-level client.
This is a concrete interface mismatch, not a conclusion that etcd is unsuitable.

## Evidence

Public npm registry resolved version 1.1.2, gitHead
`e74db2a81c68006feb770c1c21dbed5af46fdf40`. Registry metadata modified time is
2026-04-24T23:30:46.893Z; it does not establish recent source maintenance or the
version's release date. Package LICENSE is MIT, copyright Microsoft; preserve its
notice. Transitive licensing/security has not been comprehensively cleared.

Actual installed `lib/connection-pool.js`:

- Default global policy uses recoverable-error retry with maxAttempts 3.
- `runServiceCall` discards the unary call handle and exposes only its Promise.
- `exec` recursively reissues a request on `EtcdInvalidAuthTokenError`, independently
  of the ordinary global retry policy.
- Per-call deadline is passed through. This is useful, but not the same as forwarding
  E68's AbortSignal to cancellation of the individual call. Closing a shared pool
  would affect unrelated operations.

Two offline diagnostics run the installed ConnectionPool prototype with injected
fake RPC clients (no constructor, connection or listener). Both pass: deadline
preservation/hidden cancel handle, and two RPC invocations following one synthetic
invalid-token response despite a pass-through global policy. The auth test proves
retry behavior, not duplicate application of a real server write. No live durability,
authorization, restore safety or maintenance-quality claim follows from these tests.

Reproduce:

```
CR_ETCD_EVAL_ROOT=/private/tmp/cr-e69.gJhaMa node --test scripts/research/etcd-client-evaluation.test.mjs
```

Targeted ESLint passes. Application source and main dependency lock are unchanged;
the full application suite was not rerun for this research-only change.

## Provenance and next acceptance

See the E69 entry in REUSE_DOWNLOAD_LOG.md and `reuse-e69-package-lock.json`.
Installed connection-pool.js SHA-256:
`0c866a84d97ee69f6d394c4acf3c8c7a143b3d239494bd612a3f7b5eb1ecb4b3`.
Public sources: [client repository](https://github.com/microsoft/etcd3),
[published package](https://www.npmjs.com/package/etcd3/v/1.1.2).

Next transport evaluation must prove one dispatch, abort propagation, finite deadline,
late-result refusal and exact transaction response parsing using existing bindings.
Only after that should a scoped real-service rehearsal test persistence, concurrent
CAS, independent restore detection and delete/recreate refusal. The trusted independent
anchor and SQL/anchor partial-failure decisions from E64/E65 remain open.
