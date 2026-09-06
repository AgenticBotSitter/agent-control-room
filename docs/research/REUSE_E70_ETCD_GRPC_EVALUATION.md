# E70 — existing gRPC binding fits the narrow transport interface

2026-09-06. Reuses E69's retained packages and lock; no new download or service.

## Decision

Proceed to a bounded adapter evaluation using the existing gRPC unary API and etcd
transaction definitions. Do not fork `etcd3`, implement protobuf manually, or write
a storage engine. This is a candidate transport fit, not production adoption of etcd.

The necessary custom part is small: connect our AbortSignal/deadline, sanitize errors,
refuse late completion, validate the exact expected checkpoint and transaction result,
and map the result into the existing checkpoint interface. These are Control Room's
application rules; gRPC already supplies request handles and protobuf encoding.

## Verified offline

**E73 correction:** the original codec diagnostic checked bytes but not comparison
enum identity and used incorrect enum casing. It did not prove a value comparison.
E73 corrects the casing and explicitly verifies every prepared comparison target/result.
Other cancellation and identifier observations below remain separate evidence.

`scripts/research/etcd-grpc-evaluation.test.mjs` loads the actual retained etcd protocol
definitions using installed `@grpc/proto-loader` and `@grpc/grpc-js` 1.14.4. It constructs
the generated KV client with a fake channel override: no resolver, real channel,
socket or server is created. Synthetic insecure credentials are an inert test object,
not a proposed deployment setting.

Three tests pass:

1. A generated transaction returns a working cancellation handle. Canceling one call
   reports CANCELLED without closing the client or canceling the other request. The
   second request can finish successfully. Explicit deadline reaches the fake channel.
2. An invalid-authentication status completes with failure and one channel call; there
   is no high-level authentication-token reissue loop.
3. Existing transaction codecs preserve key/value bytes, failed comparison status,
   and identifiers beyond JavaScript's safe integer range as decimal strings.

The fake channel bypasses the real channel retry engine. Accordingly, these tests do
NOT prove real-network no-retry behavior or deadline enforcement. Installed
`build/src/retrying-call.js` lines 133–135 separately show `grpc.enable_retries: 0`
selects NO_RETRY and maxAttempts 1; a later transport qualification must verify this
through the actual channel under connection failure. No claim of exactly-once remote
effects is made: a lost reply can remain uncertain even with retries disabled.

Both E69 and E70 diagnostics pass together (five tests). Targeted ESLint passes.
Application runtime and main dependency lock remain unchanged; no application-wide
test rerun is claimed for these research-only additions.

## Licensing and provenance

Inspected installed gRPC and proto-loader LICENSE files: Apache-2.0. The etcd3 package
has its MIT license. Before adopting/copying protocol files, verify their upstream
provenance and any additional notices; the package-level license alone is not a full
transitive clearance. Preserve E69's lock and exact retained directory in the download
ledger. No copied upstream source is added to application code by this evaluation.

SHA-256 of retained `etcd3/proto/rpc.proto`:
`dee76abe2dfc5514a512adb3054895025e596a58f11d52fc49d5cac3f8754222`.
SHA-256 of installed gRPC `build/src/retrying-call.js`:
`f4075187109ddef2fae8b8ed31d6a8dd830368de509369c62e7db95bf4912d4f`.

## Remaining before adoption

- Adapter abort-before-dispatch, in-flight abort, deadline, late callback, malformed
  response and lost-reply cases; cancellation never proves a remote write was undone.
- Trusted explicit TLS endpoint, certificate identity and narrowly scoped permissions.
- Exact key generation/cluster identity and rollback-checkpoint comparison semantics.
- Independently retained trust anchors and real restart/restore/delete-recreate tests.
- Partial success between anchor and SQL remains a refusal/recovery problem, not a
  reason to retry, reset or quietly initialize another anchor.

No production database, checkpoint store or running Control Room service is established.
