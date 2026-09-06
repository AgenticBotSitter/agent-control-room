# E66 — awaited database pre-commit integration

2026-09-06. Local-only implementation. No new package, service, credential access,
live database, provider call, GitHub write or deployment.

## Implemented

`DatabaseClient.transactionWithPreCommitCheck` now explicitly accepts and awaits
`void | Promise<void>`. Both PGlite implementations and the PostgreSQL adapter wait
inside the transaction. The private bounded driver also waits, retaining the whole
transaction deadline, pool quarantine and no-late-COMMIT behavior. It checks query
failure/in-flight state again after the asynchronous check.

Application wrappers now propagate the result instead of discarding it: joined
sessions in artifact/submission/intake, task services, planning, assignment, review,
verification, rehearsal, native evidence and coordinator layers. Lifecycle, native
session and source-current guards remain after the await. Result-coordinator deferred
checks run sequentially and complete before commit. Synchronous clock helpers which
return a timestamp are explicitly wrapped as checks, not treated as completion data.

The offline PostgreSQL research runner's transaction helper is updated too; it was
not executed against a real server. Regression wrappers must return or await checks
under the same contract. Their cancellation, expiry and unchanged-record assertions
are preserved, not relaxed.

## Evidence and limits

New tests cover delayed successful checks, rejected checks, transaction timeout with
late completion, swallowed query failure during pre-commit, and rollback in both
actual PGlite adapters. The bounded driver tests use fake leases, not a listener.

The initial focused pass failed seven checks because remaining test-only interception
wrappers discarded the now-asynchronous callback. The broad run was started before
those fixture corrections; its results cannot alone certify the final tree. Keep the
initial failure evidence and rerun corrected coverage before accepting this block.
Final verification is recorded below.

The first broad run also found a stale pre-E60 serving inventory assertion: it
expected zero consumers although the accepted E60/E63 supplied-resource host now
composes that service. The inventory now admits that exact host only, retains one
native HTTP owner and rejects raw HTTP/net imports or ambient startup hooks in the
host. This is reconciliation with the already tested composition, not another
listener or broadened production authority.

The final main-suite rerun passed. Its posttest then exposed another pre-E62
inventory mismatch: the HTTPS service imports `isIP` and a Socket type from net,
but its server comes from HTTPS. The legacy scanner now excludes only that exact
validator/type import in that exact service, verifies the HTTPS server import, and
retains the original two raw-net server owners. Any additional net import remains
subject to the original inventory. The final posttest is rerun separately; application
source and the passing main-suite tests are unchanged by this last correction.

Final evidence:

- Preparation stage-zero ready; TypeScript, full lint and final changed-test lint pass.
- Corrected quality/result coordinator rerun: 38 pass.
- VPS build, all 41 compiled regressions and four compiled queue/schema journeys pass.
- Final pretest: 770 pass. Final main: 1,832 pass, zero fail, two Windows-only skips.
- Final standalone `pnpm run posttest`: 480 pass, zero fail/cancel/skip after the
  inventory correction. Combined final phase evidence: 3,082 pass, two skips.
  The earlier single `pnpm test` command exited 1 at the stale posttest assertion;
  it is not relabeled as an exit-0 invocation.

Sanitized local diagnostic outputs remain at `/private/tmp/cr-e66-tests.Gq9BFt`
(initial broad), `/private/tmp/cr-e66-focused.log` (initial coordinator),
`/private/tmp/cr-e66-remediated.log`, `/private/tmp/cr-e66-final.VuIFq3`
(passing pre/main, stale posttest), `/private/tmp/cr-e66-final-post.log`,
`/private/tmp/cr-e66-build.log`, `/private/tmp/cr-e66-compiled.log` and
`/private/tmp/cr-e66-queue.log`. These are generated test logs, not downloads or
required runtime inputs; they may be removed when no longer needed. No cleanup
or external acquisition was performed.

This is the database prerequisite, **not a durable checkpoint adapter**. The existing
checkpoint port and staged flush remain synchronous and still reject asynchronous
implementations (E65). Next migrate the active Completion Gate/store/configuration
path to an explicit asynchronous checkpoint port, preserving the historical exact
in-memory simulation bindings. Then evaluate the selected external storage primitive
against E64/E65 restore and ambiguous-write cases. Do not configure production with
an in-memory fallback or claim this change proves external atomicity.
