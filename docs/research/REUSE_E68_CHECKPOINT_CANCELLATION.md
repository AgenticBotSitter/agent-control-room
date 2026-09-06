# E68 — database cancellation reaches checkpoint work

2026-09-06. Local implementation, fake transports and disposable-data tests only.
No package acquisition, real service, credential operation or deployment.

## Reuse and implementation

Use Node's existing `AsyncLocalStorage.run/getStore` and `AbortController`, not a
new coordination service. The repository already uses AsyncLocalStorage in its
pg-boss transaction bridge. [Node async-context documentation](https://nodejs.org/api/async_context.html)
describes propagation across callbacks and promise chains and recommends this
implementation over hand-built async hooks. The current page is newer than our
installed Node 22; this code uses only the longstanding run/getStore operations,
not new options, snapshots or withScope. Local tests verify the installed runtime.

The bounded database driver owns one cancellation signal per operation, inherits
parent cancellation for nested operations, and makes the signal available throughout
the callback and awaited pre-commit chain. Timeout/pool invalidation aborts it;
normal completion aborts it too, so retained asynchronous work cannot treat a
finished operation as current. Query guards also inspect inherited cancellation.

Completion Gate forwards this signal to external read, initialize and advance
operations and refuses replies received after cancellation. The asynchronous stage
captures the signal at its lazy first read under the transaction, forwards it to
storage, and rechecks it after replies and before subsequent advances. Existing
joined wrappers inherit context without a new parallel transaction registry.

This context holds cancellation only: no user identity, keys, credentials or
permission. It is not an authority proof and does not relax task/owner checks.

## What the tests prove

- Concurrent operations have distinct signals; completion of one does not cancel
  another. The context is absent outside the owned operation.
- Nested work inherits parent cancellation and cannot issue a late SQL statement.
- Database timeout reaches pending checkpoint transport. A deliberately
  cancellation-ignoring first write may complete, but no second CAS or SQL COMMIT
  occurs; the stage cannot be reused. This preserves ambiguity rather than claiming
  remote cancellation undoes a write.
- Direct Completion Gate reads and initialization receive the same cancellation
  signal. A delayed read cannot proceed to initialization after timeout, and late
  initialization cannot permit SQL commit.

Final focused/regression checks: 120 pass, zero failures/cancellations/skips.
TypeScript, full lint and VPS build pass. All 41 compiled regressions and four
compiled queue/schema journeys pass. The complete default lifecycle was
not rerun for this block; E66 remains the earlier full-phase evidence.

## Remaining external-store acceptance

The optional signal keeps existing synchronous/disposable stores compatible. A real
network checkpoint adapter must require a live bounded-operation signal or an
equivalent explicitly reviewed bounded provisioning context; missing context must
not silently authorize an unbounded network call. It must bind the signal to its
actual transport and qualify deadline, abort, ambiguous-reply and restore behavior.
Generic unbounded adapters and arbitrary third-party callback/context behavior are
not qualified by these tests. SQL rollback and cancellation cannot erase an external
write that already occurred; reconciliation remains necessary for split outcomes.

Next is the pinned external-store adapter evaluation against E64/E65 cases, including
restart, deletion/recreation and restored-but-revision-bumped data. No etcd/OpenBao
installation or production-readiness claim follows from this source integration.

Generated logs are retained locally and removable when no longer needed:
`/private/tmp/cr-e68-initial.log`, `/private/tmp/cr-e68-regression.log`,
`/private/tmp/cr-e68-build.log`, `/private/tmp/cr-e68-compiled.log`,
`/private/tmp/cr-e68-queue.log`. No downloads or cleanup occurred.
