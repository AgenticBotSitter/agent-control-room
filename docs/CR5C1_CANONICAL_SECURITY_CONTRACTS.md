# CR-5C.1 canonical node-security contracts

**Status:** Implemented
**Date:** 2026-08-23
**Normative parent:** `CR5C_FINAL_SECURITY_CONTRACT.md` and ADR-023 through ADR-030
**Scope:** Types, strict validators, artifact digest/signature helpers, generated JSON Schema, and adversarial contract fixtures only

## Outcome

CR-5C.1 turns the architect-frozen containment boundary into public, machine-checkable contracts. It does not persist a ceiling or trust bundle, select a platform key store, evaluate a job, dispatch an executor, or perform an external effect.

The implemented contract surface is `src/node-policy/v1`:

- owner-signed, node-bound, monotonic authority ceilings;
- owner-root-signed server trust bundles and bundle-bound shrink authorization;
- exact-node-or-node-class approval attestations;
- normalized local policy requests, typed executor capabilities, local decisions, and coarse wire denial receipts;
- canonical filesystem-path and exact HTTPS-destination grammars;
- canonical body digests and Ed25519 artifact signatures; and
- generated JSON Schema for all seven external contract shapes.

## Complete lease authority correction

The pre-CR-5C `AuthorityEnvelope` could not represent every dimension required by the frozen strict intersection. CR-5C.1 therefore adds:

- `filesystemRoots`;
- `maxRisk`; and
- `maxConcurrentEffects`.

Those fields are included in the authority digest and delegated-authority containment checks. Job offers, lease grants, and renewals now also carry an explicit recipient `nodeId`. Grants and renewals contain the full authority plus its digest; protocol validation recomputes that digest and rejects noncanonical operation, credential, filesystem, or network lists.

This is an intentional pre-live contract correction. It is not wire-compatible with an older CR-5A producer. No live project integration exists, so every later producer must implement the generated v1 schema rather than supporting the incomplete draft.

## Frozen encoding rules

- Artifact bodies use canonical JSON and `sha256:<lowercase hex>` digests.
- Artifact signatures use Ed25519 and the literal `signatureAlgorithm: "Ed25519"` fixed by the normative contract.
- Artifact arrays are deterministically sorted and unique; wildcard forms are absent.
- Security artifact timestamps are RFC 3339 UTC (`Z`), not arbitrary offsets.
- Dollar ceilings are nonnegative canonical decimal strings with no redundant trailing fractional zero and at most six fractional digits.
- Filesystem strings must be absolute and lexically canonical. Real-path, symlink, junction, mount, and case-aware containment still require the later target-guard slice.
- Network destinations are exact `https://<lowercase-ascii-host>:<explicit-port>` strings with no path, query, fragment, userinfo, wildcard, or implicit port. DNS, address-class, TLS, redirect, and rebinding enforcement remains later work.
- Wire denial receipts contain only a fixed coarse category and server-known message/job/attempt references. Detailed denial causes and policy digests remain local-only.

## Deliberate boundaries

Schema validation proves structure, canonical digest integrity, and contract-local invariants. Signature verification additionally requires a public key supplied by the future separated trust stores. Monotonic version/epoch adoption, key lifecycle rules across bundles, attestation consumption, expiry, authority intersection, and durable effect admission all require state and are not falsely represented as schema guarantees.

## Verification

`tests/node-policy-contract.test.ts` proves:

- body and signature tampering fails;
- unknown fields, duplicate/unsorted arrays, contradictory effect settings, non-UTC time, and noncanonical money fail;
- trust bundles require an active, unique, sorted key set;
- shrink authorization is bound to the exact bundle body digest;
- approvals target exactly a node or a node class and expire after issue;
- ambiguous filesystem and network target strings fail;
- a network executor that cannot enforce network identity fails capability validation;
- detailed local denial information cannot be inserted into a strict wire receipt;
- offer/grant/renew authority must be complete, node-targeted, canonical, and digest-correct; and
- committed JSON Schema exactly matches runtime validators.

The repository gate is `pnpm check`, `pnpm lint`, `pnpm test`, `pnpm db:verify`, and `pnpm test:build`.

## Next boundary

CR-5C.2 implements the three separate protected-store interfaces, a clock boundary, explicit key availability, fail-closed provider selection, and deterministic in-memory test doubles. It must not implement native macOS, Windows, or Linux providers, persistence, policy evaluation, or executor dispatch.
