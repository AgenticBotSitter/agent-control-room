# E56 — bounded single-signature adapter

2026-09-06. Supplied-protocol implementation and offline tests only.

The adapter consumes a caller-supplied signing protocol and close operation; it never
opens a socket, discovers an agent, unlocks a key or loads ssh2 into the application.
The pinned candidate remains isolated in E55. This is the small lifecycle/verification
adapter the E55 negative finding requires, not a fork or new agent protocol.

One instance permits one attempt. It copies bytes, caps the input at 24,576 bytes,
derives the SSH Ed25519 public-key representation from the configured SPKI, and verifies
the returned 64-byte signature against the original bytes and public key. The supplied
protocol receives a separate byte copy so mutation cannot change verification material.
It uses native Node public-key/verification primitives, not custom cryptography.

Error, end, close, cancellation and a maximum 30-second monotonic deadline terminate
the outer operation. Late callbacks cannot restore success; a second invocation cannot
send again. Owned closure is attempted once, before returning success; failed cleanup
rejects the result. Channel closure does not prove the external agent stopped signing.
No timeout/error path automatically obtains another channel or signature.

This does not establish owner consent or trusted pin provenance. A caller must admit
the exact canonical material, dedicated owner key and current policy before invoking
it. A pair of approval/recovery signatures still needs an issuer that handles partial
completion without release/retry of an ambiguous packet. The signer is not mounted in
the browser, task API, native key store or deployment. No real user presence is claimed.

Verification uses the actual retained AgentProtocol for valid, malformed, silent,
wrong-key and cancelled requests. In each case there is one protocol request and one
closure; malformed replies now reject the wrapper rather than hanging on the missing
callback. The original E55 negative diagnostic remains unchanged. Unit checks also
cover byte mutation, oversize, pre-abort, late callbacks and failed cleanup. Those unit
checks run in default posttest without needing the isolated package. Exact results are
recorded in BUILD_STATUS.md. No new downloads, lockfile change or native operation.
