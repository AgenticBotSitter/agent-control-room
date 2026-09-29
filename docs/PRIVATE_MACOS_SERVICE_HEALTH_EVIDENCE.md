# Private macOS service health evidence

**Status:** source-only authenticated-evidence contract. It has not invoked
`launchctl`, read a protected directory, loaded a credential, started a
service, written a journal, or inspected a live database.

`private-macos-service-health-evidence.ts` supplies the missing evidence shape
for a future `platform_service` journal success. It does not alter the current
service runner or journal. Until the settlement boundary is explicitly wired
to consume this evidence, an ordinary running observation is not proof of this
new health contract.

## What is bound

One verifier captures an installation-private HMAC key and one exact current
installation binding: installation ID, plan digest/revision, owner identity and
the fixed `gui/<owner uid>/<xyz.agentcontrolroom.local>` launchctl target. The
publisher is only the captured owner UID or UID 0 (root); a root publisher is
still bound to the owner's GUI domain. It also binds the exact service label and
identity, release and configuration, service instance, database authority,
protected-data, supervisor-readiness, and readiness digests.

The verifier issues one 32-byte base64url nonce challenge with a maximum
two-minute lifetime. A native owner/root publisher must return a `healthy`
reply that repeats every binding exactly, includes an observation made during
that window, and authenticates that complete reply with the captured
installation-private HMAC key. The key is copied into closure state and is
never returned, logged, accepted from a reply, or persisted by this module.
Private composition must call the verifier's idempotent `close()` operation in
a `finally` block; closing erases that copy and permanently disables the
verifier.

The first valid reply produces only a redacted, digest-bound
`eligibleForJournalSuccess: true` evidence record. The same exact challenge and
response may be verified again only in the same live verifier, before expiry,
to handle a lost local reply. This in-memory object is not restart recovery; a
reconstructed verifier cannot adopt its old challenge. A changed response,
including a differently signed health observation, is refused. Expired,
foreign-installation, wrong domain/instance/release/configuration, forged,
unhealthy, accessor-backed, prototype-substituted, or extra-field input also
refuses.

## Remaining native and journal work

This is not a native implementation. A later reviewed macOS port must establish
owner/root identity, publish through the existing no-follow service boundary,
query exactly the fixed launchctl target, consume the verifier's fresh
challenge, and sign the resulting complete reply without exposing the key. The platform
service settlement must then require this fresh authenticated evidence—not a
cached generic observation—before it appends a success. That integration needs
its own review because it changes the durable installation journal boundary.

## Verification

`node --import tsx --test tests/private-macos-service-health-evidence.test.ts`
runs disposable checks for inert construction, fixed owner/root publication
bindings, freshness, forged/stale/substituted refusal, exact replay only,
accessor/prototype/extra-field rejection, key copying, redaction, and absence
of filesystem/process/service implementations.
