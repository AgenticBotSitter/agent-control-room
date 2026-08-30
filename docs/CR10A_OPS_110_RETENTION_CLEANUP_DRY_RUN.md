# CR10A OPS-110 retention and quarantine cleanup dry run

**Status:** Complete for the exact local synthetic, authenticated, executor-disabled boundary
**Scope:** Re-derived cleanup plans, bounded fake inventory, dry-run reports, one-use idempotency, authenticated lifecycle truth, tombstone/quarantine/source evidence rules, restart reconciliation, safe projection, and a no-target CLI
**Not in scope:** Private-body reads, locators, paths, credentials, real inventories, legal decisions, owner approval, storage/database/filesystem/provider clients, deletion, compaction, movement, quarantine mutation, source mutation, or any external effect

## Exact plan

`src/operations/v1/retention-cleanup-dry-run.ts` accepts an OPS-100 candidate only when it can re-run the original registry, policy, request, retention evidence, legal holds/releases, and assessment and reproduce the exact proposal. Substituting a valid assessment or proposal from another request fails before a cleanup plan exists.

Every plan contains twelve fixed steps:

1. re-derive the exact candidate;
2. require the current project policy;
3. require a fresh bounded inventory;
4. require current legal-hold clearance;
5. require every dependency horizon;
6. require independent active-reference absence;
7. prepare non-authorizing tombstone or source evidence;
8. require a fresh owner decision;
9. require a one-use protected effect claim;
10. require a durable pre-effect marker;
11. require an independent terminal receipt and postcondition evidence;
12. append audit evidence and reconcile without retry.

The four candidate actions stay separate:

- body deletion requires a pending deletion tombstone;
- full-record compaction requires an atomic digest-tombstone replacement;
- source-authoritative content requires source reconciliation evidence;
- quarantine requires immutable quarantine evidence.

Plans expire within fifteen minutes and accept at most 100,000 inventory records and 1 TiB of declared bytes. These are safety ceilings for this contract, not production retention values or permission to scan storage.

## Bounded dry run

The only current inventory adapter is a repository-created frozen fake. It carries counts and digests only: record set, item/byte counts, active-reference count, legal-hold count, existing tombstone/quarantine counts, and fresh evidence digests. It cannot read a body, resolve a locator, or call an injected callback.

A fresh hold, active reference, record-set drift, already-absent target, existing tombstone, or existing quarantine state prevents the ordinary candidate route. Already-terminal-looking evidence goes to reconciliation rather than being treated as successful cleanup. Even an otherwise clean report becomes only `candidate_for_external_authority_review`; `cleanupAuthorized` remains false.

`npm run ops:retention:dry-run` builds one deterministic synthetic body-deletion example and prints only the safe projection. It accepts only `--json` and has no target, locator, command, or native adapter.

## Authenticated lifecycle and idempotency

`OperationsRetentionCleanupAuthenticatorV1` HMAC-authenticates the complete lifecycle state with an exact ordinary 32–64 byte key. It also advances an independent rollback checkpoint for every mutation. An old authenticated state, wrong key, changed state, hostile binary view, or absent/mismatched checkpoint fails closed.

The cleanup operation ID and idempotency key derive from the exact plan, record set, and action. Starting the same operation twice conflicts at the checkpoint boundary. Exact claim, marker, receipt, and reconciliation replay is inert; changed replay fails.

The current claim and marker are explicitly synthetic rehearsal evidence. Native claim, marker, receipt, and attempt counts remain absent or zero. Restart behavior preserves the future real-effect rule:

- before a claim, the dry run remains safely resumable;
- after a claim but before a marker, restart records definite pre-marker failure with no retry;
- after a marker without a receipt, restart records terminal ambiguity and rejects late success;
- after a complete receipt, independent reconciliation may resume;
- terminal or reconciled states never start a second attempt.

Synthetic success requires independent postcondition and audit evidence. Deletion and compaction additionally require a tombstone digest; quarantine requires quarantine evidence; source reconciliation requires source evidence. Definite failure has a separate failure digest and cannot be relabelled success. Unknown post-marker outcome ends in terminal ambiguity.

## Safe projection and disabled executor

The projection verifies the lifecycle HMAC and current checkpoint before rendering plan/report/operation digests, action, dry-run outcome, lifecycle status, counts, and whether a tombstone is required. It exposes no controls, commands, content, locator, approval, or authority.

The private executor accepts only a repository-created plan in the same process and always returns `disabled_before_execution`. A copied or ordinarily re-signed plan cannot enter it.

## Deliberately absent

- production policy, inventory, reference, legal-hold, subject, tombstone, quarantine, source, or audit adapters;
- files, paths, tables, rows, buckets, objects, URLs, endpoints, providers, accounts, credentials, or resolved locators;
- owner-decision verification, native effect claims, native markers, or native receipts;
- deletion, movement, compaction, source reconciliation, quarantine mutation, automatic retry, or any external effect;
- production key custody, durable lifecycle persistence, or production rollback-resistant checkpoint custody.

A future native boundary must be separate, owner-authorized, independently reviewed, action-specific, and unable to weaken the OPS-100 precedence or the OPS-110 idempotency, tombstone, receipt, audit, reconciliation, and terminal-ambiguity rules.
