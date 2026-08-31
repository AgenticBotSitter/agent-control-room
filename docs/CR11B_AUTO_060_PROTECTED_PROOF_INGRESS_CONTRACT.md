# CR11B-AUTO-060 Protected Proof Ingress Contract

Status: second remediation implemented after two independent rejections; different-agent re-review required

Date: 2026-08-30

## Purpose

AUTO-060 adds the first proof-intake boundary for the nine immutable production requirements defined by AUTO-050. It can
establish that a digest-only envelope is cryptographically consistent with a repository-fixture trust root, the accepted
AUTO-050 plan and assessment, an exact proof authority, and—where required—a distinct independent verifier.

It cannot establish production custody or production qualification. Every accepted envelope is
`observed_unqualified`. All nine production gates remain blocking even when all nine fixture envelopes verify.

## Authority boundary

The only supported trust mode is the literal `repository_fixture_only`. The trust anchor is supplied outside the proof
ledger and binds one tenant, workspace, owner-root key ID, canonical Ed25519 SPKI, and raw-key SHA-256. Treating that
caller-supplied fixture anchor as protected production custody is forbidden.

An owner-signed trust bundle binds:

- one tenant and workspace;
- a monotonic revision and prior-bundle digest;
- its issue and expiry window;
- exact issuer/verifier identity, key ID, canonical Ed25519 public key, and key digest;
- an independence-domain digest;
- the exact proof authorities and gate codes each identity may address;
- whether the identity may independently verify; and
- active or terminally revoked state and revocation time.

The bundle body digest excludes only itself. The owner signature covers the complete body including that digest. Every
Ed25519 signature must decode to exactly 64 bytes and round-trip to the exact supplied base64url string before verification.
Textual aliases for the same signature bytes are rejected. Identity
and key IDs and public keys are unique; identities, authorities, and gate codes are canonical. Active identities have no
revocation time. A revoked identity must have been revoked no later than the signed bundle revision.

The authenticated trust history retains every identity binding. An existing identity cannot disappear or change identity
ID, key ID, public key, key digest, independence domain, proof roles, gate roles, or verifier role. Active may transition
once to revoked at a monotonic signed time. Revoked can never return active. New identities require wholly new key identity.

No private key, credential, locator, evidence body, production root, or protected-reference value belongs in the bundle,
envelope, ledger, projection, fixture, test, log, or repository.

## Exact proof envelope

Each envelope binds all of the following:

- proof, tenant, and workspace identity;
- AUTO-050 plan ID/digest and assessment ID/digest;
- one exact gate code, requirement digest, evidence class, and proof authority;
- every required binding code in the exact AUTO-050 order, with one digest per binding;
- a deterministic aggregate evidence digest over the gate and ordered bindings;
- issuer identity and key;
- trust-bundle ID, revision, and digest;
- observation, issue, expiry, and receipt chronology; and
- the proof-body digest and issuer Ed25519 signature.

Proof observation cannot predate the AUTO-050 assessment. Issue cannot precede observation or the trust-bundle issue.
Receipt cannot precede issue and must occur before proof and bundle expiry. Proof lifetime is at most one hour and cannot
extend beyond the AUTO-050 plan. A future, stale, overlong, cross-plan, cross-assessment, cross-tenant, or cross-workspace
envelope fails closed.

For every requirement marked `independentVerifierRequired`, a second active identity signs an exact verification record
over proof-body digest, trust-bundle digest, identity/key, and verification time. Issuer and verifier must have distinct
identity IDs, key IDs, public-key digests, and owner-signed independence-domain digests. The verifier must be authorized
for that gate and for independent verification. The owner-approval requirement forbids an unsolicited independent record
because its AUTO-050 rule does not require one.

Cryptographic consistency produces an immutable observation with false approval, activation, claim/lease,
dispatch/execution, and external-effect flags. It never produces `qualified`.

## Authenticated local ledger

The reference ledger is a private, owner-mode SQLite file for effect-free repository validation. It is not protected
production custody and cannot become production storage by configuration.

The ledger records only two append-only artifact kinds:

1. owner-signed repository-fixture trust bundles; and
2. exact assessment, envelope, and derived observation packages.

Every row is authenticated with an external HMAC key. Complete ordered ledger state has its own digest and HMAC. A
separate captured reference checkpoint performs compare-and-swap over revision, record count, state digest, and state
authentication tag so restoring an older database fails. The private schema, columns, indexes, file owner/mode, link
count, canonical JSON, row sequence, row identity, signatures, proof derivation, trust chain, and checkpoint are verified
on every read and mutation.

Trust revisions must start at one and advance one revision at a time with the exact prior digest and increasing issue time.
Only the current stored bundle may admit a new proof. An exact repeated bundle or proof is inert, including an old exact
proof replay after active or revoking trust advances and when ledger capacity is full. Reusing an ID with a
different digest is replay drift. Store capacity is checked before append. SQLite tampering and database rollback fail
closed.

The ledger retains the original private file path and device/inode identity. Before and after each read or mutation it
rechecks private parent and file ownership/mode, regular non-symlink form, single-link count, unchanged device/inode, and
the complete exact SQLite objects, columns, and SQL. Open-store permission drift, hard links, path replacement, or added
tables/indexes/triggers/views fail before state is returned or an append is accepted.

The repository checkpoint implementation is deliberately in-memory and test-only. Durable protected checkpoint custody,
hosted multi-process locking, backup/restore, availability, and production concurrency remain unproved.

## Store-private assessment and revocation truth

The only assessment builder is owned by the authenticated store. There is no exported raw-observation assessor, proof
assessment parser/projector, projection parser, public aggregate assessment/projection schema, or raw assessment method. It
re-verifies the AUTO-050 assessment with its protected HMAC context, verifies current ledger state and the owner-signed
fixture bundle, filters ledger-derived observations to the exact assessment chain, and rejects an evaluation time earlier
than the latest authenticated ledger record or the AUTO-050 assessment. Each gate is one of:

- `unobserved`;
- `observed_unqualified`;
- `expired`;
- `revoked`; or
- `superseded` by a later trust revision.

A missing, revoked, or changed current issuer/verifier identity revokes the observation. A proof from an older trust
revision is superseded and must be renewed. Proof or bundle expiry makes the observation expired. None of these states is
qualified.

The assessment always reports `qualifiedProofCount: 0`, `remainingQualifiedProofCount: 9`, all nine blocking gate codes,
`eligibleForOwnerApproval: false`, `eligibleForActivation: false`, and no operational authority. Nine current,
cryptographically valid repository-fixture observations still leave the state `blocked_fixture_proof_only` with safe reason
`protected_production_custody_unavailable`.

## Safe projection

`projectAssessment` is the only trusted projection operation. In one call it re-verifies the private file and exact schema,
every ledger package and authentication tag, the rollback checkpoint, current trust chain, and exact AUTO-050 assessment;
derives assessment state without accepting a caller proof assessment; and deep-freezes the returned safe view. Public
SHA-256 remains content identity, never proof of ledger provenance. The projection contains only
tenant/workspace, plan/assessment/proof-assessment IDs, safe gate/status pairs, counts, all
nine blocking gate codes, and false capability flags. It excludes evidence and binding digests, signatures, public keys,
key and identity detail, trust-bundle detail, authentication tags, private locators, protected references, evidence bodies,
and operational controls.

## Hostile acceptance boundary

The candidate must prove:

- canonical owner-root, issuer, and independent-verifier Ed25519 verification;
- exact root, key, role, gate, requirement, plan, assessment, tenant, workspace, and chronology binding;
- complete ordered binding coverage and deterministic evidence aggregation;
- real issuer/verifier independence across identity, key, and signed domain;
- stale, future, overlong, expired, revoked, superseded, forged, incomplete, reordered, and cross-scope rejection;
- exact replay is inert and same-ID drift is rejected;
- trust revisions cannot skip, fork, or roll back;
- SQLite tampering and database rollback fail against authenticated state and external checkpoint;
- partial and all-nine proof assessments remain unqualified and blocked;
- no caller-re-digested assessment or projection can enter a trusted exported consumer;
- the safe projection omits protected proof material; and
- proof ingress imports no network, provider, deployment, secret-resolution, claim, dispatch, or effect client.

## Stop boundary

AUTO-060 does not collect real evidence, enroll a production root, store private signing keys, issue owner approval,
qualify any production gate, resolve protected references, contact a hosted database or destination, construct a consumer,
schedule work, claim or lease, dispatch or execute, contact an agent or provider, mutate GitHub, activate recurrence, read a
native host, operate DNS/Cloudflare/hosting, deploy, or cause an external effect.

A future production proof service must replace fixture trust and the in-memory checkpoint with independently qualified,
protected custody; prove hosted multi-process behavior and production clock/key/revocation semantics; preserve the exact
negative-authority model; and receive fresh owner authority and independent security review. AUTO-060 evidence cannot be
promoted or relabelled into that proof.
