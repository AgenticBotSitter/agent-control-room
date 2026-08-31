# CR10A OPS-100 privacy and retention contract

**Status:** Complete for the exact local policy, evidence, and proposal boundary
**Scope:** Data classification, revisioned retention policy, deletion and erasure requests, legal holds and releases, retention evidence, audit preservation, review proposals, safe projection, and a disabled executor
**Not in scope:** Legal advice or determinations, private-body reads, locators, paths, credentials, storage/database/filesystem/provider access, actual deletion or movement, approval, or any external effect

## Data classes

`src/operations/v1/privacy-retention.ts` freezes fourteen classes in exact order:

1. scope and identity binding;
2. source-versioned projections;
3. work and job lifecycle truth;
4. approval and authority evidence;
5. audit and security truth;
6. effect replay and idempotency truth;
7. broker-private credential-reference metadata;
8. sanitized observability data;
9. immutable artifact metadata;
10. private artifact bodies;
11. public artifact bodies;
12. transient transport bodies;
13. backup and recovery material;
14. quarantine evidence.

Each definition fixes purpose, sensitivity, possible privacy association, custody, representation, retention basis, dependency-horizon requirement, disposition mode, and audit-preservation rule. The parser compares each definition with the repository-built canonical definition, so an ordinary recomputed digest cannot change its meaning.

Audit/security rows are indefinite append-only full records and never become disposition candidates. Effect-replay, approval, work, scope, artifact-metadata, and quarantine truth can at most become digest-tombstone compaction candidates after every dependency horizon. Private bodies and other body-bearing classes can at most become deletion-review candidates. Source-authoritative public bodies and projections require source reconciliation rather than local deletion inference.

The registry contains no raw material, locator, legal conclusion, approval, deletion authority, or execution authority.

## Retention policy

A policy binds one tenant, workspace, project, and registry digest. It has an immutable revision number, effective time, and ordered rule for every class. Revision one cannot name a predecessor. Every later revision must name the previous policy digest.

Each rule is one of:

- `configured_duration`, with an owner-supplied non-negative number of days;
- `blocked_unconfigured`, which has no invented deadline and always preserves the target;
- `source_authoritative`, with a digest reference to the external source policy;
- `indefinite_preservation` for full audit/security truth.

No default duration is used by the production contract. The exported synthetic-policy builder exists only to create deterministic local tests and examples. Jurisdiction-specific and legal rules must be supplied from outside Control Room by an authorized process. The policy explicitly makes no legal determination and cannot authorize disposition.

## Requests and holds

A disposition request binds the exact project policy, data class, record-set digest, request kind, and request time. A subject-erasure request requires a pseudonymous subject-reference digest. Raw subject identity, content, locators, and legal conclusions are forbidden.

The request kinds are retention expiry, owner deletion request, subject erasure request, and quarantine review. Every kind remains a request for evidence and review, never an action.

A legal hold binds exact project scope, an ordered class set, optional subject digest, externally supplied authority/basis evidence digests, and an effective time. An active relevant hold wins before expiry, deletion request, erasure request, or quarantine handling. A subject-specific hold also blocks a broader request that cannot prove the subject is outside the hold. Control Room does not decide whether a hold is legally required or valid.

Release evidence binds one exact hold digest and external authority/basis digests. It can stop that hold from blocking after its release time, but is evidence-only: it neither deletes data nor grants approval or authority. A hold or release from another project is rejected.

## Retention evidence and precedence

Evidence binds the request, policy, class, record set, retention clock, evaluation time, inventory digest, reference digest, and audit-chain head. Classes with dependency horizons require a known maximum horizon. If any required horizon is unknown, the target is preserved. Active references also preserve it.

The evaluator applies this order:

1. active legal hold;
2. append-only audit preservation;
3. unconfigured policy;
4. unknown dependency horizon;
5. active reference;
6. retention window not yet elapsed;
7. quarantine review;
8. the class-specific deletion, digest-compaction, or source-reconciliation review route.

Only the final three routes are candidates. Every other result is an explicit block or `not_due`. The evidence and assessment contain no raw read, locator resolution, legal decision, or effect.

## Candidate gates and disabled execution

Every candidate proposal carries ten ordered prerequisites:

1. exact scope and current policy;
2. current bounded inventory;
3. retention or request basis;
4. legal-hold clearance;
5. complete dependency horizons;
6. absence of active references;
7. a fresh owner decision;
8. a protected effect claim;
9. a pre-effect marker;
10. an independent terminal receipt and audit record.

The present proposal records the last four operational prerequisites as absent and contains no commands, locator, credential reference, native executor, approval, or authority. The private disabled adapter accepts only a proposal created in the current process and always returns `disabled_before_execution`. A copied or re-signed proposal cannot cross that boundary.

OPS-110 may add a dry-run/idempotent cleanup state machine around these candidates. It must not add a native deletion client, treat a candidate as approval, infer missing evidence as success, retry after a marker or ambiguous result, remove required tombstones, or weaken hold and audit precedence.

## Safe projection

The projection contains only scope/policy/registry digests, configured and blocked counts, bounded class cards, safe reason codes, candidate flags, and hold counts. It contains no controls, commands, private content, raw identity, locator, approval, or effect authority.

## Deliberately absent

- actual retention values for production projects;
- jurisdictional interpretation or legal advice;
- private subject or artifact content;
- files, paths, buckets, objects, tables, rows, endpoints, provider identifiers, credentials, or resolved references;
- a storage, database, filesystem, object-store, provider, shell, process, or network client;
- deletion, movement, compaction, quarantine mutation, automatic retry, approval, or execution authority.
