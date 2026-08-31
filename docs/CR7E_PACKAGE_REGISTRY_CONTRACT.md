# CR-7E procedure and knowledge registry contract

**Status:** Effect-free repository implementation complete locally
**Schema:** `control-room-package-registry/v1`
**Authority:** ADR-043 and ADR-052

## Purpose

The registry gives Control Room reusable, reviewable procedure instructions and project knowledge without turning either into policy or permission. A package can help a worker understand what to do or what is known. It can never decide whether the worker may do it.

## Four boundaries

| Boundary | Meaning | May grant authority? |
|---|---|---|
| Procedure | Repeatable steps and deterministic acceptance steps | No |
| Knowledge | Evidence-linked facts and content-addressed references | No |
| Policy | Eligibility and required gates, outside this registry | No; it decides eligibility only |
| Authority | Separately issued, operation-bound permission | Yes; never stored in a package |

Every package carries literal negative declarations for authority, policy, and credentials. Strict schemas reject extra fields, including attempted authority, policy, or credential fields. The shared secret scanner rejects secret-bearing text before persistence.

## Immutable package versions

A package version binds tenant, project, kind, name, version, provenance, compatibility declarations, separation declarations, content, and creation time into one canonical SHA-256 digest. Identity replay succeeds only when the complete digest is unchanged. Reusing an ID or a semantic version with different content fails.

Procedure content is limited to an objective, ordered method steps, acceptance steps, and named input/output roles. Knowledge content is limited to evidence-linked facts and content-addressed references. Knowledge cannot contain procedure steps, and a procedure cannot contain facts.

Provenance records the source type, source identity, source digest, producer identity, and production time. A run outcome may register a candidate revision but cannot activate it.

## Review and compatibility

Review records are append-only and exact-package-digest bound. The reviewer must differ from the producer and must supply evidence. A rejection is durable and cannot be rewritten into acceptance.

A harness mapping binds the exact package digest to an exact adapter version, harness version, platform, and verified lifecycle verbs. The verified verb set must exactly equal the package declaration and every verb must be supported by the strict adapter manifest. The exact manifest and its digest are stored inside the authenticated mapping, so a changed manifest cannot reuse an earlier verification. The mapping verifier must differ from the package producer.

Compatibility means only that the reviewed instructions can be delivered through the verified mapping. The compatibility result always states that it grants no authority and cannot permit execution by itself.

## Promotion and rollback

Activation is a serialized, optimistic transaction for one tenant/project/kind/name channel. It requires:

1. the exact immutable package version;
2. an accepted independent review bound to that digest;
3. a verified harness mapping bound to that digest;
4. the caller's exact expected active digest.

A rejected or stale command leaves the active version unchanged. Every successful promotion appends an immutable event and advances the mutable channel pointer. Rollback is another reviewed activation event; it may target only a version that was previously active. History is never edited or deleted.

The resolved active projection includes the package, promotion, and mapping plus explicit `false` values for authority, policy, approval, dispatch, and execution. A separate authority envelope and all existing policy/effect gates remain mandatory.

## Persistence

Migration `0021_cr7e_package_registry.sql` adds five tables:

- `control_package_versions`: immutable content and provenance;
- `control_package_reviews`: immutable independent decisions;
- `control_package_harness_mappings`: immutable compatibility evidence;
- `control_package_promotions`: immutable promotion/rollback history;
- `control_package_channels`: the serialized active pointer only.

Database triggers reject update, delete, and truncate operations on all four history relations. Tenant/project foreign keys and digest-bound composite foreign keys prevent ordinary cross-scope substitution. An external 256-bit integrity key authenticates every package, review, mapping, promotion, and mutable channel row. Resolution reconstructs the complete consecutive promotion chain and revalidates each package, independent accepted review, exact manifest mapping, action semantic, prior link, chronology, and active pointer; a database writer cannot create accepted history merely by recomputing ordinary SHA-256 fields.

## User interface

The dashboard registry section is deliberately read-only. It distinguishes active, candidate, rejected, reviewed, and compatibility states, identifies exact adapter/platform mappings, and repeats the non-authority boundary. The present screen is labelled as a synthetic fixture; it does not claim protected registry data or offer activation controls.

## Non-goals

This block does not deploy a package service, authorize a worker, execute a procedure, ingest live external references, read credentials, or perform a native harness action. A future protected API must preserve the same tenant, digest, review, compatibility, policy, and authority boundaries.
