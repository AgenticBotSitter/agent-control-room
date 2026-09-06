# E65 — checkpoint integration findings and false-success fix

2026-09-06. Local source/test work and public documentation research. No download,
service, credential operation, GitHub write or deployment.

## Concrete defect repaired

The staged Completion Gate checkpoint flush discarded `advance()`'s return value.
TypeScript permits an asynchronous implementation in a `(): void` slot, so an
unfinished network write could be treated as completed and SQL could commit.
Flush now rejects any non-undefined return, observes late rejection without logging
its contents, closes the stage and does not start the next advance. This is a
synchronous-port compatibility guard, **not asynchronous storage support**. It
cannot undo or cancel an external write already initiated by a misconfigured adapter.

Tests exercise pending fulfillment and rejection through the existing bounded SQL
driver with a fake lease: BEGIN then ROLLBACK, no COMMIT, one advance only, and no
reuse after late settlement. Non-void synchronous output is also rejected. Existing
partial-flush behavior remains terminal; successful synchronous stores are unchanged.

## Research that changes acceptance tests

- etcd key deletion resets its version; creation revision identifies the latest
  creation. A value/version check alone cannot distinguish all delete/recreate
  histories. [etcd API](https://etcd.io/docs/v3.6/learning/api/#key-value-pair).
- Supported snapshot restore changes cluster identity and may move revisions
  backwards. Revision bumping raises the counter but does not recover newer data.
  Therefore accepting a larger revision is not evidence of current checkpoint
  content. Persistently trusted cluster/key-generation identity and independent
  recovery handling need evaluation; learning both anew from restored data is
  insufficient. Raw disk rollback is a separate scenario from the restore command.
  [etcd recovery](https://etcd.io/docs/v3.6/op-guide/recovery/).
- OpenBao separates data-write, delete, undelete, destroy and metadata policy paths.
  Metadata deletion removes all versions. Those controls warrant an exact-policy
  evaluation, not a claim that generic KV access enforces our checkpoint semantics.
  [OpenBao KV v2](https://openbao.org/docs/secrets/kv/kv-v2/).

These are upstream observations followed by Control Room-specific inferences.
Neither candidate is adopted. E64's narrow etcd evaluation remains first, but its
acceptance cases must include bumped old snapshots, key recreation and restart
without an in-memory high-water mark. OpenBao remains an alternative, not another
service to install in parallel. Administrative compromise is not silently added to
the product threat model; ordinary restore boundaries still must meet the existing
checkpoint contract. No replacement consensus engine is justified by these findings.

## Coherent asynchronous integration scope

Do not widen the shared synchronous checkpoint interface and assume compilation
proves correctness. Several historical simulation stores intentionally bind only
the exact in-memory implementation; preserve that boundary. A separately named
asynchronous production port can coexist until each active consumer is migrated.

| Layer | Required change and evidence |
|---|---|
| Database boundary | `src/persistence/database.ts` and `src/web/v1/bounded-database.ts`: await pre-commit work; rejection prevents COMMIT; the existing whole-transaction deadline still quarantines late work. |
| Nested transaction wrappers | Audit all `transactionWithPreCommitCheck` implementations, including artifacts, result submission, connection intake, execution planning, assignment, review/verification and native evidence. A wrapper that calls an async check without awaiting defeats the outer fix. |
| Authority wrappers | Coordinator lifecycle, quality, result, native sessions/evidence and planning must recheck authority after an awaited external operation, not just before it. Session/grant expiry tests remain required. |
| Completion Gate | Await reads/initialization/advances in the store; retain SQL integrity locking. Stage a bounded exact CAS sequence, await each flush operation, stop on the first uncertain outcome. |
| Callers/configuration | Review, verification, native submission and automated verification must await the flush; planning and startup must supply the new production port explicitly. No memory fallback. |
| Recovery | Anchor advancement followed by SQL failure remains a split outcome. Do not reset the anchor, silently reinitialize, or retry changed work to manufacture agreement. |

This is an implementation inventory, not a completed migration. Test-only wrappers
and fixture implementations must also be audited when the DatabaseClient contract
changes. A source-wide search is required then, rather than treating this table as
an exhaustive permanent file list.

## Verification

- Stage-zero preparation: ready for runtime check; no native readiness attempt.
- Checkpoint, native submission, owner review and owner verification: 58 passed,
  zero failures/cancellations/skips.
- TypeScript and targeted lint: passed.
- VPS production build: passed with existing framework deprecation/dynamic-import
  warnings. All 41 compiled regressions passed, zero failures/cancellations/skips.
  No live storage acceptance is implied.

Next: implement the awaited transaction/Completion Gate path as one coherent block,
then evaluate one pinned external store against the corrected acceptance cases.
Any real listener/database rehearsal still requires scoped authority.
