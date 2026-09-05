# CR14C — verify accepted native profile evidence

Date: 2026-09-05. Repository-only component based on PR #307.

`createNativeProfileEvidence` implements the existing start/recovery controller's profile-check port.
It verifies an owner-signed acceptance of qualification evidence; it does not conduct qualification,
inspect or install a profile, unlock credentials, or trust native capability JSON as proof of isolation.

## Accepted record

The domain-separated `control-room.native-profile-acceptance/v1` body binds every enrollment field
except its own qualification digest: tenant, node, connection, native revision, destination, profile,
credential reference, profile-policy digest, model/provider and expiry. It also binds node class,
owner approval key ID, issuance time, sanitized evidence digest and the required guarantees: dedicated
profile, tool/MCP/plugin/skill policy enforcement, hard deadline, filesystem and network isolation.
All guarantees must be explicitly accepted, not absent or false.

The enrollment's qualification digest hashes the complete signed acceptance artifact. The signed body
excludes that digest to avoid a circular hash. Body digest/signature are verified with the separately
configured scoped owner-public-pin store, including current server/owner key-role separation. An
arbitrary record plus a matching hash is insufficient. This module does not provide an acceptance signer
or route that allows workers to certify themselves. The evidence digest refers to owner-reviewed host
evidence; cryptography proves the owner's acceptance, not the underlying physical facts independently.

## Current supervised state

The caller supplies the same protected security repository used by its approval store and a trusted
synchronous supervisor-state reader. The snapshot must bind the complete enrollment digest, accepted
qualification digest and profile-policy digest, with explicit active state, available credential,
monotonic revision, observation time and validity ending no later than enrollment expiry. Future or
expired state, disabled profiles, missing credentials, revision rollback and same-revision conflicting
content deny. The trusted supervisor must increment revision when snapshot content changes.

A per-instance time high-water prevents an observed expiry from being undone by clock rollback. A
newer observed disabled state also advances revision tracking before denial. Structurally valid
matching expired or future supervisor snapshots also advance the revision watermark before denial,
preventing older longer-lived evidence from restoring permission. This is not durable restart rollback
protection; the real supervisor/configuration authority must provide that separately.
No fallback state reader, credential lookup or approval source is supplied.

## Asynchronous boundary

Capture verified committed server-trust revision and supervised state before awaiting owner-key
resolution. Verify the signed acceptance and recheck the captured state afterward. Return a synchronous
freshness closure that rechecks current time, profile state, owner-pin lifetime/disposal and trust revision.
Both start and recovery controllers invoke it after the profile callback yields and again at their
outer authorization/admission boundary. Later state changes invalidate proof rather than trigger retries.

Legacy trusted profile callbacks returning void remain compatible; the verified evidence provider always
returns the closure, and runtime wrappers must preserve it. The controllers retain their bounded checks
and unresolved-work limits. This is not a cross-process atomic transaction or a guarantee about physical
effects after permission is checked. Transport still owns the existing immediate pre-byte authorization.

## Remaining work and limits

There is no persistence schema, runtime registration, filesystem inspection, native credential operation,
provider call, network listener or deployment in this block. Synthetic tests do not earn host acceptance.
The pinned native revision still needs the separately gated real setup/readiness/native qualification,
owner review and signature, controlled profile policy installation, real supervised state reader and
private destination qualification. Old Hermes/native evidence is not silently reused.

Owner signing/intake, durable local supervisor/cleanup configuration, signed dispatch and revision
submission remain repository work. Live C-WORK remains incomplete. Continue Astra Medium.
