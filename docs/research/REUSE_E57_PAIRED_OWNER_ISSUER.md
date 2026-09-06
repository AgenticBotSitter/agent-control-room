# E57 — paired owner approval issuer

2026-09-06. Local, unwired implementation with synthetic consent and keys only.

The issuer joins E53's canonical approval/recovery material to E56's supplied-channel
signer. It returns only a complete, schema-checked packet after verifying both exact
signatures against the supplied owner public key. Existing canonical intake remains
responsible for current trust, task binding and storage authorization.

One issuer permits one attempt. Consent and time are checked before signing, between
signatures and before release. The trusted synchronous consent guard is bound to the
review digest; accidentally supplying an async guard rejects before signing. A wall
clock high-water check and whole-operation monotonic deadline reject expiry/rollback.
Cancellation, failure or uncertainty prevents packet release and consumes the attempt.
Late first-signature completion cannot request the second signature. No automatic
retry, persistence, channel acquisition or execution is implemented.

This is deliberately small product glue: ssh2 supplies the signing protocol, existing
Node primitives verify signatures, and existing Control Room schemas/intake define the
packet. The application-specific pairing and consent checks are not provided by the
upstream protocol. No upstream fork or additional download was needed.

## Evidence

The actual isolated ssh2 1.17.0 AgentProtocol, E56 adapter and this issuer produce a
complete packet accepted by canonical storage with `startsWork: false`. The test
uses two in-memory channels, closes both and refuses a second invocation. No SSH
socket, existing key, provider, credential store or physical listener is accessed.

The combined package diagnostics and canonical storage suite pass 22 tests, zero
failures/cancellations/skips. Cases include revoked/missing consent, corrupt signature,
second-signature failure, expiry, timeout, accidental async consent and late completion.
The storage suite is already part of the default test inventory; the downloaded-package
evaluation remains opt-in with its exact version/source hash checks.
Stage-zero preparation, TypeScript and targeted ESLint checks also pass. This is
focused verification, not a new full-suite or production-build acceptance run.

## Remaining work

The injected guard is not implemented owner consent or proof of attendance. Trusted
prepared-request delivery, separate owner key provisioning/custody, current pin
configuration and an actual owner-facing approval flow remain required before wiring.
Failure to return a packet does not prove an external signer performed no signature.
Aborting the signal cannot stop an uncooperative supplied signer. No real runtime
acceptance, installed service, deployment or new live authority is claimed.
