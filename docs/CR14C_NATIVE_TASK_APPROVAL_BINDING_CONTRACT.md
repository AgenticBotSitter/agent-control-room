# CR14C — exact native task approval binding

Date: 2026-09-05. Repository implementation, no runtime activation.
Base: PR #299 / `b037b85651f411a22932b9df77646b7f7d6316af`.

## Why this is needed

The existing normalized effect digest binds identity, executor, operation, destination, credential
references, risk and duration/cost. Native start also needs its exact prompt, instructions, selected
model/provider and qualified profile committed into the owner-approved effect. Otherwise an adapter
integration could approve the same operation/destination while substituting different task content.
No such production adapter integration is currently mounted.

Add an optional SHA-256 `payloadDigest` to the normalized request and pre-effect operation material.
When present it participates in the existing operation digest, hence owner approval, effect claim key,
destination idempotency key and durable pre-effect marker. It is mandatory for
`harness.hermes.native.start`; generic operations remain backward-compatible when it is absent.
Legacy digest material is unchanged. Older nodes that cannot parse this additional field must refuse
the request, not strip it or down-convert a native start. This is not a new protocol-negotiation claim.

## Typed native preparation

`prepareNativeTaskApproval` consumes a trusted authenticated saved-plan input, canonical job/attempt/
lease snapshot and node-local reviewed enrollment. The caller must establish provenance and current
authorization in a checked transaction. Supplying plain records is not proof of either.

Only the existing initial one-attempt native task class is accepted: leased job and unstarted leased
attempt, matching active lease/node/epoch, exact input digest, no dependencies/retry recovery, the fixed
approval-required low-risk native operation and one matching credential/destination. Cost-dependent
authority, filesystem scope, delegation and broader operations are refused. Expired/future or mismatched
reservations fail closed. Errors are fixed codes, not private payload or infrastructure details.

The payload digest commits the exact prompt/instructions digest, full enrollment digest, lease ID/
epoch, authority digest and absolute task deadline. Enrollment binds destination, credential reference,
model, provider, profile/policy, qualification reference, revision and validity. Its references remain
references: the later controller must resolve current accepted evidence, not accept self-issued digests.
Deadline is bounded by lease expiry, authority expiry, enrollment expiry and duration from lease
acquisition. It is stable across a later preparation of the same unchanged reservation.

The normalized operation yields the existing effect claim key, deterministic native run ID, and native
session/request binding through `bindNativeStart`. No circular hash includes a session derived from its
own effect key. Changing payload, enrollment, lease or authority changes the operation and invalidates
the previous approval. Repeating unchanged material retains the same effect/session identity.

`verifyNativeTaskApprovalBinding` recomputes and compares these exact commitments at the node seam.
It is a binding verifier, not a permission oracle: signed owner approval, signed lease provenance,
ceiling, executor capability, local pause, current keys/qualification, effective deadline and durable
claim/marker remain required. The controller must not exceed the prepared deadline or an earlier
approval/ceiling deadline. An earlier approval deadline does not authorize silently rebuilding a different
payload; obtain matching approved material or refuse. Start/status/events/stop authority remains distinct.

## Durable marker and evidence

Pre-effect creation copies the optional commitment and validates its digest syntax. Marker validation
requires its exact key set and recomputed operation digest. Removing/replacing it cannot reuse the claim.
Old marker material without the field remains readable for old operation types. No SQL or SQLite schema
migration is needed: existing journals retain the canonical serialized operation and its integrity chain.

Tests begin with the actual disposable proposal/planning/assignment services, build native material,
verify real synthetic Ed25519 owner signatures through the existing local policy evaluator and commit
the payload-bearing marker through the existing SQLite effect store. Tampered content/enrollment/lease,
wrong/missing signer, absent binding, expiry and duplicate effects are refused. Synthetic key generation
does not access an owner credential or establish human attendance. Policy fixtures supply synthetic
ceiling/lease provenance; real signatures do not imply a live node or host qualification.

## Not yet delivered

No owner signing UI/key custody, coordinator dispatch writer, signed frame delivery, fully composed
native authority controller, physical transport or runtime activation. This component is required
input to those integrations, not a completed executable workflow. No live/provider/credential/listener
operation, deployment or merge is authorized by this block. Continue repository integration on Astra Medium.
