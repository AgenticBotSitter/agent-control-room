# E05 — pg-boss continuous pickup and canonical delivery integration

2026-09-06. Local implementation; no production activation or new native authority.
Uses the existing E01 pg-boss 12.30.0 acquisition and repository PGlite. No download,
application dependency change, listener, PostgreSQL server, provider or native agent.

## Implemented reuse

`src/persistence/pg-boss-native-task-worker.ts` calls the package's public `work`,
`getQueue`, `cancel` and `offWork` APIs on an already-started dedicated client. pg-boss
owns polling, concurrency, pickup, operational completion/failure and worker-group
draining. Control Room does not add another polling, retry or scheduling loop.

- Single item per callback, one-second library polling, configurable concurrency 1–8.
  These are delivery slots, not canonical native-agent capacity grants.
- Validate the fixed queue configuration and each claimed record's schema, stable ID,
  queue, active state, standard policy, zero retry limit/count and absence of dead letter.
  Structurally unsafe operational rows are cancelled before invoking the canonical
  handler. Operational cancellation does **not** cancel a Control Room task or process.
- A shared queue can contain several tenants. Current tenant/project authorization is
  resolved by the trusted canonical handler, not by a retained browser session or by
  deleting every job outside one worker's preferred tenant. Queue locators are not authority.
- Handler gets an immutable locator/digest snapshot and combined library/shutdown abort
  signal. Its captured callback must revalidate current canonical approval, attempt,
  project and node before effect admission. Native execution is not implemented here.
- Only the coarse `delivered` or `held` disposition is accepted as successful operational
  output. It must follow the canonical service's recorded outcome; it is not task success,
  a verified artifact or owner acceptance. Do not wait for review in a delivery worker.
- Errors and invalid return values become a fixed unresolved error, with no original
  message, cause or stack/local paths serialized. Automatic native retry remains disabled.
- `close` stops new callback admission, signals current handlers and delegates group
  draining to pg-boss. Late results after abort are denied. The owning startup must bound
  that drain and own the dedicated client/pool cleanup; this adapter cannot prove an
  uncooperative external process stopped. No custom supervisor is introduced.

Custom-code justification: the package supplies the generic engine. The small bridge
maps its records into Control Room's existing immutable identifiers and canonical
authorization services. DBOS/Hatchet also require that application-specific mapping;
neither is needed to supply a second worker loop now. The handler boundary is explicit,
not an invented substitute for native approval or authentication.

## Evidence

Actual package evaluation command:

```sh
CR_REUSE_EVAL_ROOT=<retained E01 root> node --import tsx --test \
  scripts/research/pg-boss-submission-integration.test.mjs \
  scripts/research/pg-boss-worker-integration.test.mjs
```

**26 passed, zero failed/skipped**, exit 0, approximately 25 seconds:

- Existing 13 canonical submission/role/replay cases still pass.
- Seven new canonical-path cases exercise real package pickup into the existing
  assignment coordinator and synthetic signed node session. One transmission intent
  and one in-memory transport entry occur; no authenticated receipt means unresolved,
  not delivered. Canonical enqueue replay cannot trigger another send.
- Expired approval, lost owner role, closed approval pins, retired node key, completed
  project and tampered packet digest each block staging/transmission after pickup.
- Six library-worker cases prove continuous pickup while a synthetic review is pending,
  concurrent delivery handlers, one failed uncertain callback with later jobs proceeding,
  malformed/retry-enabled row rejection, worker-group shutdown/replacement and abort drain.
  The review example's hold marker is synthetic, not a real application review workflow.

The new unit suite has **16 passing checks** covering options/callback capture,
malformed and mismatched metadata, queue drift, pre-abort, tenant routing, error/output
redaction, continuing after a hold, late return and unfinished-close uncertainty.
It is registered in the default repository test script. Typecheck and targeted lint pass.
Seven related suites (submission, worker, canonical queue, saved approval, envelope,
transmission and receipt) also passed **103 checks**, exit 0, approximately 26 seconds.
This is targeted verification; no full repository build/test or independent review claimed.

### Preserve the original failed experiment

The first expanded canonical run had 16 passes and one failed test. That test called
`native.revoke()` and incorrectly expected it to revoke the independently pinned owner
approval before staging. Inspection of the fixture and `PinnedApprovalTrustStore` showed
it revokes a **server-trust key**, not the owner approval key/role. Trust changes during
the checked transaction are separately fenced by existing tests. The test was replaced
with explicit current owner-role, pin disposal, node-key and project-lifecycle changes;
none required weakening product checks or changing trust code. Do not describe the
original run as wholly green, or claim these tests prove revoked-server execution safety.

## Not finished / next composition

This is an opt-in worker adapter plus actual-package integration evidence, not a running
fleet. No worker is registered in private startup, no production queue schema is
provisioned, and pg-boss is still an isolated evaluation dependency. Restricted worker
UPDATE/cancel/completion grants are not proven by the earlier producer-role test.

Remaining queue adoption work: package/role/bootstrap composition with explicit ownership
of the producer and dedicated worker clients; canonical current authorization resolution
without serializing browser credentials; durable held/receipt recovery classification;
schedule occurrence/review relationships; real-PG final-adapter concurrency and crash/
restore; deliberate legacy-intent cutover. Existing E02 permission was spent; later
native database or live-agent acceptance needs a fresh scoped authorization.

All E05 processes exited and synthetic fixture teardown completed. E01–E04 downloads
remain as recorded in the cleanup ledger. No remote GitHub activity other than previously
authorized public research, no publication, and no independent review claimed here.
