# CR-5C.3 persistent ceiling and server-trust state

**Status:** Implemented
**Date:** 2026-08-23
**Normative parent:** `CR5C_FINAL_SECURITY_CONTRACT.md`, ADR-023, ADR-030, and ADR-032
**Scope:** Owner-pin verification, monotonic local security artifacts, crash recovery, and irreversible server-key lifecycle

## Outcome

`SqliteNodeSecurityStateRepository` is the production persistence boundary for the signed node authority ceiling and owner-signed server trust bundle. It uses two explicitly different SQLite database paths:

- the artifact database contains the currently accepted signed artifact and server-key history; and
- the high-water database contains only the highest prepared or committed ceiling version and trust epoch plus its canonical body digest.

Both databases use WAL mode and full synchronous commits. They deliberately do not pretend to form one cross-file transaction. Adoption instead uses a recoverable protocol:

1. validate the strict schema, canonical body digest, Ed25519 signature, out-of-band owner pin, and tenant/node or tenant/node-class binding;
2. durably prepare the higher sequence and exact body digest in the independent high-water database;
3. transactionally write the signed artifact and, for trust bundles, the complete key-history update;
4. mark that exact high-water record committed; and
5. only then return success to the caller.

A crash before step 3 leaves the old artifact and a prepared future sequence. Reads fail with `recovery_required`; replaying the exact pending owner artifact completes the operation. A crash after step 3 is completed deterministically from the fully verified stored artifact. A crash after step 4 is an ordinary duplicate on retry.

## Owner pins and bootstrap

`PinnedOwnerTrust` accepts an explicit out-of-band pin set for three separate roles:

- the ceiling provisioning key;
- the server-trust root key; and
- one or more trust-shrink step-up keys.

Each pin contains an Ed25519 SPKI and SHA-256 fingerprint. Construction parses the key and recomputes its fingerprint; malformed, wrong-algorithm, or mismatched pins fail with a fixed safe configuration error. The pin provider remains deployment input and is not learned from a Control Room message.

Initial ceiling and trust state must use `provisionInitialCeiling` or `provisionInitialTrustBundle`. Normal `adoptCeiling` and `applyOwnerSignedBundle` fail when no committed state exists, including when initial provisioning stopped after prepare. This prevents the online operational path from silently becoming a bootstrap path. Re-presenting the exact artifact through the explicit provisioning API safely resumes a bootstrap crash.

## Monotonic and lifecycle rules

The ceiling repository rejects lower versions and rejects a different signed body at the current version. It accepts an exact current artifact as an idempotent duplicate.

The trust repository additionally retains every observed key identifier and SPKI digest. A later bundle must retain all historical key identifiers, cannot change the SPKI behind an identifier, cannot introduce one SPKI under another identifier, and cannot reactivate a retired or revoked key. Every bundle requires at least one active key. Replacing all previously active keys requires a countersignature over the candidate bundle-body digest from a separately pinned trust-shrink key.

Only active keys resolve through `ServerTrustStore`; returned DER bytes are newly allocated. Online server keys do not participate in trust-bundle verification and therefore cannot authorize their own replacement.

## Fail-closed states

- Artifact present but high-water missing, or the reverse: `rollback_detected`.
- Valid artifact older/different than committed high-water: `rollback_detected`.
- Prepared update with no matching stored artifact: `recovery_required` until the exact pending owner artifact is supplied.
- Invalid JSON, signature, mirrored columns, or key history: `corrupt` for stored state.
- Invalid candidate signature, scope, digest, lifecycle, or countersignature: `invalid_bundle`.

All public failures use fixed `ProtectedStoreError` messages. Signed public artifacts are checked by the repository secret-material guard before persistence.

## Deliberate limits and stop boundary

The independent high-water database detects deletion or rollback of only one side. Coordinated rollback of both database files by a same-UID or host-level attacker is not detectable without a stronger external monotonic primitive. Protecting file ownership, backup/restore procedures, process identity, and the two paths is a CR-6 deployment and rehearsal obligation; this slice makes no stronger claim.

This slice does not implement native private-key providers, protected owner-pin storage, owner-pin rotation, authority intersection, executor admission, approval issuance, effects, timers, target guards, networking, or live Control Room integration. `valid_until` remains deferred under the frozen contract.

## Verification

`tests/node-security-state.test.ts` exercises bad pins, path separation, explicit bootstrap, persistence across reopen, forged signatures, scope mismatch, monotonic version/epoch replay, same-sequence conflict, artifact tamper, partial deletion, valid-artifact rollback, every ceiling write fault boundary, every trust write fault boundary, exact-artifact recovery, key omission, SPKI aliasing, retired/revoked reactivation, unauthorized full active-key replacement, valid shrink countersignature, active-only key resolution, and key-history tamper.

The repository completion gate remains `pnpm check`, `pnpm lint`, `pnpm test`, `pnpm db:verify`, and `pnpm test:build`.
