# CR14C — separate owner-provisioned approval trust

Date: 2026-09-05. Repository-only implementation, based on PR #304.

## Root of approval authority

The existing security contract requires owner effect approval to be distinct from online server signing.
`PinnedApprovalTrustStore` implements the existing ApprovalTrustStore port using an explicit out-of-band
owner-configured public pin set. It contains exact tenant/node/node-class binding, a validity interval
and 1–16 canonical Ed25519 SPKI public keys with fingerprints and unique identifiers/material.
It has no private key, signer, generated default pin, file reader, network updater or self-provisioning.

This local configuration is a root of trust, not a remotely supplied signed artifact. Its provenance must
be established by the trusted owner-attended deployment/configuration path. A browser, job, agent or
ordinary online server cannot supply or replace it. Construction merely validates/copies supplied public
configuration; it does not prove that the owner installed it. No owner configuration is installed here.

## Current separation checks

Every known-key resolution loads the current verified owner-signed server trust bundle through the
existing protected repository. Scope must match the configured tenant/node class. It checks every
approval pin against every retained server key, including retired/revoked keys, by identifier and actual
canonical key fingerprint. One collision makes the configured approval set unavailable. A different
name for the same server material is not separate approval. Newly introduced collisions fail on the
next check rather than using cached success. Protected-store uncertainty also fails closed.

The repository retains server key history in each accepted bundle and verifies it against its durable
anti-rollback state. The approval store relies on that existing verified loader; passing an unverified
lookalike callback is not production composition. It does not reinterpret server signatures as owner
effect approval. Nor does it issue the separate approval attestation or recovery permission.

`resolvePinnedApprovalKey` first checks expected tenant/node/node-class scope and then adapts the returned
public bytes to the existing start/recovery policy input. Production native composition must use this
scoped adapter with its trusted enrollment binding, not ignore the pin set's node scope.

## Lifetime, bounds and configuration changes

Pin configuration is immutable for one store instance. Unknown key IDs return unavailable; input mutation
and mutation of returned bytes cannot change stored keys. Validity is checked before/after asynchronous
work. Per-instance clock high-water advances even on expiry rejection; an earlier clock cannot resurrect
that instance after it has observed expiry. Reconstructing with a rolled-back clock is not defended by
this object; deployment must supply a trustworthy clock and current owner configuration.

At most eight trust resolutions are unresolved, with no queue. Each has a maximum five-second wait,
shortened by pin expiry. Slots remain occupied until underlying work settles. A timeout disables the
instance and rejects its other pending calls; an uncooperative underlying read is not claimed stopped.
`close` similarly rejects pending callers and permanently disables the instance without closing caller
resources or cancelling a remote task. Late successful reads cannot return approval keys after close.

There is no in-place approval rotation/revocation API or persistent approval epoch in this block. To
change/revoke pins, the trusted supervisor must disable the old instance and explicitly construct a new
one from the owner's current configuration. Old instances must not remain available. Deployment/config
rollback policy and any future authenticated hot-reload mechanism remain required work, not capabilities
claimed by this immutable store. Existing short effect-approval expiries remain independently enforced.

## Test boundary and remaining integration

Tests use actual disposable owner-pinned server-trust repositories and signed bundle updates, public
pins from generated synthetic owner keys, real native start/recovery controllers and a fake transport.
They cover server alias/identifier collisions including retired keys, fresh signed trust updates,
malformed/duplicate pins, immutable bytes/configuration, scope/expiry/clock failure and stalled reads.

No native credential, private owner key, host configuration, listener, provider, production database or
deployment is accessed. This is not a login method or human-attendance proof. Owner approval signing
custody/UI/intake, remaining current policy/profile sources, signed dispatch and bounded revisions
remain C-WORK requirements. Continue Astra Medium.
