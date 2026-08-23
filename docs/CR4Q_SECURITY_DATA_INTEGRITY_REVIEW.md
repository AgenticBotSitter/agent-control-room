# CR-4Q independent security and data-integrity review

**Review date:** 2026-08-22  
**Reviewer route:** Codex, `gpt-5.6-sol`, max reasoning  
**Scope:** CR-4A through CR-4D contracts, migrations, repositories, policy, delivery, audit, configuration, and database-role definitions  
**Result:** Pass after remediation; no unresolved CR-4 high or medium finding

## Findings and disposition

| ID | Severity | Finding | Disposition |
|---|---|---|---|
| Q-H1 | High | A stored policy decision was checked for actor/action/resource/project but not exact risk and external-effect classification at consumption. A caller could request a lower classification for the same effect ID. | Fixed. Approval and effect consumers require exact risk/external-effect/project binding and a current active identity/grant. Negative tests prove under-classification fails. |
| Q-H2 | High | Lease claim/renewal and effect creation did not enforce the job authority expiry, duration, operation, effect policy, destination, and lineage boundaries. | Fixed. Claim/renewal enforce expiry and maximum duration; effect creation enforces operation, effect policy, allowlist, job/attempt lineage, approval digest, and approval risk. |
| Q-H3 | High | Several CR-0–CR-2 foreign keys used globally unique IDs without tenant-composite scope. This prevented overwrite but allowed cross-tenant references and silent projection loss after an ID collision. | Fixed by migration 0007 and projection-store tenant/adapter/workspace checks. Projection cursors and changes now carry tenant scope. |
| Q-H4 | High | Generic canonical creation could insert an attempt or active lease without the coordinated claim transaction, and an effect did not require an active attempt. | Fixed. Public creation rejects attempts/leases, only `claimReadyJob` creates them, and effects require active job/attempt state. |
| Q-H5 | High | `requiredActorType` on approvals was not enforced, and consequential consumption did not recheck identity/grant revocation. | Fixed. Matched decision grants must contain the required owner/operator/policy role and remain active at consumption. |
| Q-M1 | Medium | Audit anchoring checked only the stored head, not the recomputed event chain; PostgreSQL `bigint` values were also assumed to be JavaScript numbers. | Fixed. Anchoring verifies under the locked transaction, and counts/sequences are normalized with safe-integer bounds. A simulated trigger bypass proves tampering is rejected. |
| Q-M2 | Medium | Outbox claim, acknowledgement, failure, and recovery methods were not tenant-scoped. | Fixed. Every delivery operation requires tenant scope and tests prove one tenant cannot claim or acknowledge another tenant’s row. |
| Q-M3 | Medium | Claim/expiry/renewal replay checks were not fully bound to the original lineage/content; transition timestamps could regress. | Fixed. Replay checks bind IDs, epoch/content, actor, version, state, and timestamp as applicable; transitions reject time regression. Migration 0007 makes transition idempotency unique per tenant/entity-kind. |
| Q-M4 | Medium | `SafeOperationalError` accepted an arbitrary supposedly-safe message and an unchecked correlation ID, allowing accidental detail leakage. | Fixed. Codes map to a closed message catalog and unsafe correlation IDs are omitted. |
| Q-M5 | Medium | Production default privileges automatically granted new tables to application/read roles, making future migrations fail open. | Fixed. New database objects receive no Control Room role privilege until explicitly reviewed and granted. |
| Q-M6 | Medium | Production origin/session validation and secret canaries missed paths, obvious placeholders, JWTs, AWS access-key IDs, and credential-bearing URLs. | Fixed with fail-closed checks and negative tests. Pattern detection remains defense in depth, not a substitute for secret references. |

## Accepted boundaries, not CR-4 defects

- The application database role remains part of the trusted control plane under ADR-002/003/009. It can operate canonical tables; a compromised control plane is contained by typed executors, node-local ceilings, destination credentials, and separate consequential approval. Database row-level security and further role splitting become mandatory before multi-user SaaS operation.
- Node signatures, nonce verification, enrollment, executor identity, and message-size/rate controls belong to CR-5A/CR-5C. CR-4 inbox validation is not represented as authentication.
- PGlite proves deterministic application/schema behavior but not multi-session PostgreSQL locks, role grants, process-kill boundaries, WAL recovery, or migration behavior on populated production data.
- A local audit hash chain cannot detect a database-superuser rewrite unless heads are exported. The provider-neutral anchor contract exists; a durable external publisher is required before production evidence relies on it.

## Release decision

CR-4 is accepted as the secure local foundation for the disposable CR-5 synthetic-node phase. This is not approval for live project credentials, public ingress, production effects, or source-system mutation.
