# Durable protected-data stage transaction

**Status:** accepted source-only settlement boundary. It performs no filesystem,
storage, backup, restore, database, credential, repair, deletion, or retry
effect and has not touched an owner's directory.

## Reuse decision

This package implements the **Protected local results** retain decision in
`INSTALLATION_REUSE_IMPLEMENTATION_MAP.md`. It reuses:

- `installation-plan-journal.ts` as the only durable store;
- `installation-action-preparation.ts` and
  `protected-data-recovery-preparation.ts` for the exact running plan and
  protected storage binding;
- `protected-data-recovery-owner-action.ts` for the exact redacted owner
  request; and
- `private-protected-root-owner-runner.ts` as the only source of terminal
  protected-root evidence.

No external filesystem framework, scheduler, state machine, receipt store, or
donor code was added. The existing protected storage and recovery components
remain the owners of their respective operations.

## Settlement contract

`confirmProtectedDataActionTerminalV1` rebuilds the exact action and binds the
installation ID, topology, release, plan revision, running protected-data
stage, passed database outcome, prior protected-root binding, storage
configuration and namespace, owner-action request, verified root observation,
and storage-preflight receipt.

The private composition must put the exact protected-root runner result inside
the transaction's terminal confirmation envelope. That envelope prevents a
runner result from being substituted between two installations with identical
plan bytes. Preparation output, incomplete or changed evidence, a stale plan,
an uncertain stage, and competing terminal outcomes all refuse.

The transaction appends one plan revision. Its stage outcome is exactly
`protectedDataBindingDigest`; it is deliberately not the transaction receipt
digest. This preserves the contract already consumed by recovery preparation.
Exact concurrent confirmation becomes one append and one replay.

## Why recovery is not settled here

The existing recovery preparation correctly verifies an already produced
disposable backup-and-restore proof, but there is no accepted private recovery
runner or terminal-confirmation wrapper yet. Treating preparation as terminal
authority would weaken the boundary. This package therefore does not append a
`recovery` outcome. A later package must bind an exact verified restore proof
to an accepted private terminal runner before the journal can settle recovery.

## Disposable evidence

The focused tests cover exact restart replay, same- and changed-evidence
concurrency, foreign-installation substitution, malformed and non-terminal
evidence, storage/request/operation substitution, stale refresh, and uncertain
journal state. They also verify that the source imports no filesystem,
database, backup, restore, credential, or process implementation.

Run them with:

```sh
node --import tsx --test tests/protected-data-action-transaction.test.ts
```
