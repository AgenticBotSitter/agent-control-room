# CR-5C.8 durable effect claims

**Status:** Complete

**Scope:** Node-local effect identity, durable pre-effect intent, restart ambiguity, evidence-gated settlement, and retained terminal replay

## Delivered boundary

`SqliteEffectClaimStore` is a node-local SQLite ledger separate from the bridge delivery journal and central PostgreSQL state. It requires a filesystem path in production, enables WAL with full synchronous commits, uses immediate transactions, and exposes no external-effect implementation.

The stable claim key is the SHA-256 digest of tenant, node, project, job, attempt, and normalized operation digest. Delivery message IDs are secondary aliases only. A new message carrying the same exact effect therefore replays the existing claim, while a message ID reused for a different effect fails closed. Claim creation accepts a live `executing` or `expiring_soon` execution-authority snapshot and derives all authority bindings from it.

One atomic transaction creates the unique claim before dispatch. A second transaction writes the pre-effect marker and changes `claimed` to `executing`. The marker binds the complete normalized effect material, canonical target, authority digest, claim key, and effective deadline. The destination idempotency key is the stable claim key; this supplies a repeatable destination key but does not claim exactly-once delivery.

## Crash and settlement rules

- `claimed` with no marker can return to the ordinary policy and authority recheck.
- `executing`, or any persisted marker without terminal truth, becomes `ambiguous` on recovery.
- `ambiguous` never becomes dispatchable and never auto-retries.
- `confirmed` requires a destination receipt digest.
- `executing` or `ambiguous` may become `failed` only with a digest of affirmative non-execution evidence.
- `cancelled` is available only before the pre-effect marker.
- Terminal results replay for fresh delivery messages and after restart.

Claim snapshots, marker rows, event rows, state mirrors, event-chain transitions, and terminal tombstones are all digest checked on load. Recovery classification and ambiguity persistence occur in one immediate transaction. Reused event and marker IDs are idempotent only when their complete content is identical.

## Retention

Nonterminal and ambiguous records never compact. A settled full record may compact only when every retention horizon is known and the latest of job retention, destination idempotency, late authority delivery, and protocol retry has passed. Compaction keeps a digest-bound terminal tombstone and the delivery-message alias mapping while deleting only the larger full history. There is deliberately no tombstone deletion API in this slice; any future owner retention policy must be explicit and cannot infer a safe horizon.

## Verification

`tests/node-effect-claims.test.ts` covers identity dimensions, fresh-message aliases, two-store serialization, live-authority derivation, exact marker binding, deadline equality, duplicate and conflicting IDs, pre-marker recovery, post-marker restart ambiguity, prohibited automatic retry, evidence-gated failure and confirmation, terminal replay, horizon-gated compaction, permanent tombstones, production path enforcement, and persisted snapshot/history tampering.

The complete repository test, lint, type-check, migration, production-build, and rendered-HTML gates pass.

## Explicitly deferred

This slice performs no external effect, live destination reconciliation, native filesystem or network I/O, approval issuance or consumption, platform key access, process-kill rehearsal, true multi-process stress test, or deployment. Destination-specific evidence adapters and operator-directed ambiguity resolution must preserve the ledger states rather than bypass them.
