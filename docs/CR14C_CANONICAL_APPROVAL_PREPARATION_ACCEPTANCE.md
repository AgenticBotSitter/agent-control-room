# CR14C canonical approval-preparation evidence

Date: 2026-09-05. Status: corrected product independently accepted and locally verified.

Initial product: `e7ca5c8c0f0e86a30ed9f3d97de1a2f48588c5d5`.
Accepted corrected product: `51cdd1db63d97dd2b7bf3e98de04a4fbe1f5d98b`.
Accepted tree: `a3202ec302e46f56b7560245e8ada6472b294f30`.
Base: `b52a14c0f9c996afe68343880e798c7745979877` (PR #309).

Eight focused tests passed after a test-authoring correction. The initial run passed seven and failed
one because it attempted to modify append-only transition history; the database correctly refused the
UPDATE. The replacement test injects a missing read result at the test database boundary without
weakening the trigger or changing production history. No qualification/native attempt was involved.

Tests use real disposable canonical plan/assignment, project/session/grant, node and lease stores.
They cover exact saved content/binding, configured enrollment snapshots, missing config, wrong digest,
expired reservation, inactive node, revoked session/owner role, commit-time deadline crossing and
missing assignment evidence. They assert no new approval/effect/outbox/canonical transition is emitted
and the operation is absent from the existing browser-facing assignment surface.

The first independent review passed 46 focused tests with no blocking findings, suggesting direct key
coverage. The subsequent broad CR14C run passed 380 and failed one: application code imported the native
adapter namespace. This was a real integration failure, not an allowed exception. Pure schemas and
binding helpers were moved unchanged into shared harness contracts, with native compatibility re-exports.
The existing isolation test was not edited. The failed wrapper stopped before preparation/main/post suites.

Additional key tests initially failed because revocation omitted its required timestamp and the future-key
case tried to change immutable validity metadata. An initial run reported nine passed/three failed; a
filtered repeat reproduced the fixture failures. Corrected revocation supplies its timestamp, and future
validity is injected at the read boundary. Real database constraints remain intact. The corrected focused
preparation/isolation run passed 13 tests and TypeScript.

Independent re-review accepted the corrected head with no blocking findings. It verified both shared
modules are byte-identical after import-path substitutions, have no native-runtime dependency, and preserve
all payload/authority semantics. The reviewer made no edits or live calls. Exact command, exit zero:

```sh
node --import tsx --test tests/canonical-approval-preparation.test.ts tests/task-assignment-coordinator.test.ts tests/native-task-approval-binding.test.ts tests/hermes-native-isolation.test.ts
```

Observed: 44 passed, zero failures/skips. Uncommitted documentation was excluded from product acceptance.
Corrected-head CR14C verification passed 385 tests. The full installed-script lifecycle exited zero:
preparation 769 passed, main 964 passed with two existing platform skips, and post-suite 392 passed.
Both private and Sites builds passed, with 16 private compiled checks and four rendered-route checks.
TypeScript, full ESLint and stage zero passed. Disposable migrations 0001–0046 verified 132 tables.
The stage-zero suggestion was not executed as a native readiness or qualification attempt.
Whitespace verification passed. Only documentation changes followed the accepted product head.
Published in [PR #310](https://github.com/MarvinAi5/control-room/pull/310), targeting PR #309's branch.
Current-head GitHub CI remains required before dependency-order integration; no merge is claimed.

This is not packet storage,
owner signing, runtime dispatch or physical host qualification. No live credentials/providers/listeners,
production database, deployment or merge were used.
