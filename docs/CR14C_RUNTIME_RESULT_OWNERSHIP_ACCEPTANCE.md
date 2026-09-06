# Trusted runtime result ownership: evidence

2026-09-05. Production `9324d5d` with independently accepted correction `9857e42`;
integrated evidence `31e3d7a` is independently accepted.
Contract: `CR14C_RUNTIME_RESULT_OWNERSHIP_CONTRACT.md`.

## Implemented

The optional private task runtime owns a separately restricted result connection to the
same PostgreSQL primary. Startup verifies all three roles before installation. The
internal result commands register the actual saved execution plan's initial/revised
review binding and submit authenticated, re-read saved bytes for owner review. They
cannot approve quality, start an agent or change canonical job/attempt/lease state.
The existing web/coordinator role files and absent-option two-pool behavior are preserved.
Migration0055 adds an inert job lock and a native-linked target/revision insert guard.

Initial and revised child registration/submission execute under the actual restricted
role in disposable tests. The v2 fixture's original generation is privileged setup;
this is not proof that both generations of one chain used the new writer throughout.
The compiled initial lifecycle uses the mounted three-role runtime, fake native transport
and separately captured authenticated bytes. Browser assets exclude the writer, and
there is no public registration/submission endpoint.

## Independent review and retained corrections

Root owns production, contracts, SQL and integration. Two agents authored isolated
test files; a third reviewed the production changes and final evidence. The delegation
skill limited worker writes to evidence. Sites guidance preserved the existing build
profiles, authentication and PostgreSQL architecture; no Site deployment was attempted.

Initial review found three issues: joined transactions could lock the predecessor after
the shared review gate, pool health was not rechecked after commit acknowledgement,
and fresh-registration expiry was not retained to final precommit. Root corrected all
three in `9857e42`; independent re-review found no remaining production findings.
Regression tests exercise predecessor-before-gate SQL order, deadline crossing only at
precommit, and connection loss only after a durable save. Lock-order observation uses
serialized PGlite, not physical multi-connection PostgreSQL concurrency.

The environment rejected sharing installed dependencies with isolated test checkouts.
Agents instead authored source-only patches without setup, installs, downloads or a
dependency workaround. Root integrated their stopped patches and executed them from
the existing installed project. The backend agent could not write protected Git
metadata, so root committed its exact stopped files and correction.

The initial backend run passed7/failed19 of26. PGlite retains the changed session
identity after `SET LOCAL SESSION AUTHORIZATION`; later privileged fixture setup and
fault injection therefore ran under the restricted login. Explicit synthetic-admin
restoration at labelled setup/readback boundaries fixed the fixture. Every tested
writer/preflight/negative-SQL call still re-enters its real restricted login. No grant,
guard, production timeout or expected security rejection was weakened. Corrected26 passed.

Initial startup/compiled tests passed13/failed2 of15. The capture-test router compared
against a mutable input; the compiled fixture registered after completed progress,
which the product correctly refused. The correction fixes the independent router and
registers the discovered run before fake progress. Subsequent compiled runs exposed
incorrect fixture receipt/snapshot paths and nonexistent SQL `id` columns; these are
test-only schema/readback corrections. Earlier failures are not passing evidence.

## Verification

- macOS stage zero passed against the unchanged frozen lockfile and existing installation.
- Restricted writer/SQL evidence:26 passed, zero failures/skips/cancellations.
- Three-role startup evidence:13 passed, zero failures/skips/cancellations.
- Existing role/startup/lifecycle regression:52 passed after production corrections.
- Existing compiled private application:28 passed. Both application builds, rendered
  HTML4, TypeScript, full ESLint and disposable migrations0001–0055/138 tables passed.
- Final integrated four-file run:41 passed, zero failures/skips/cancellations in52.19
  seconds. This includes all26 backend,13 startup and two compiled tests against the
  final product. The compiled new tests also passed separately after the schema fixes.
- All four new files are registered in the standard commands without removing existing
  coverage:275 default lifecycle files, plus the compiled result-ownership file. Eight
  deterministic inventory checks passed. The broader run retains the prior272-file
  pre/main inventory and unchanged post lane; new files were exercised separately above.
- All six broader lanes passed:2,518 tests, two existing platform skips, zero failures
  or cancellations. Counts: pre770; main-1 287/one skip; main-2 346; main-3 324;
  main-4 399/one skip; post392. All used the final production correction; the new275-file
  registered default set still requires current-head GitHub CI as a complete inventory.

Prerequisite PR #336 at `8e3247ee24de4f1402b1cc47b29f6a196c3da844` passed all nine
GitHub jobs in run `34012452533`. This block requires its own current-head CI and
dependency-order integration. No merge or deployment is claimed.

## Remaining

Canonical run/progress registration and authenticated result capture still require
trusted runtime ownership. Server session routing/recovery, owner signing/custody,
physical PostgreSQL/host preparation and the first supported live task remain. The
separate upstream workflow/request completion gate remains unresolved; excluded draft
PR #329 is not adopted or re-reviewed. The overall live-use exit is incomplete.
