# CR14C task execution planning — repository acceptance

**Date:** 2026-09-05. **Disposition:** independently accepted; unmounted, not deployed.
**Product:** `48c30f7feb3aeadcc7b252ce67e0f3a4bb357583`.
**Tree:** `05152ac602715cac63b7a716233e38d25b01c0e4`.
**Base:** `114f584fa32ec6fb0801fb6630981ca51f617e34` (PR #293).
Branch: `codex/cr14c-task-execution-planning`.

## Delivered

Owner-authorized planning preserves the original inert task proposal and creates a distinct proposed
execution bundle with immutable source, template, input and review-profile lineage. Existing private task
reads can display the child. A trusted fixed template describes one approval-required native text turn;
neither the browser nor worker supplies replacement instructions, authority or an acceptance profile.

Current owner-only planning permission is separate from read/propose permission. Project/session/grant
checks and a final template-time check protect the atomic save. Deterministic identities and one plan per
source reconcile concurrent calls and lost responses without duplicating work. Historical replay does not
renew an expired template or start another job. Private-web SQL privileges remain unchanged.

The internal review binder connects the saved plan to the preceding checked-result submission service
after separate canonical admission/run registration. The positive disposable test uses the actual proposal,
planner, signed result ingestion and owner review, with explicitly synthetic claim/run transitions between
them. Those fixture transitions do not implement or qualify live admission/dispatch.

Migration 0045 adds immutable PostgreSQL plan lineage; schema/preparation pins advance to 132 tables.
Shared pure identifier definitions preserve the native adapter's exports while avoiding application imports
of its unwired subtree. No isolation test was weakened. See `CR14C_TASK_EXECUTION_PLANNING_CONTRACT.md`.

## Review and verification

Initial independent review found one P2/Medium remaining-duration timing defect. Root also found an
adapter-isolation import regression in two focused suite runs (180 passes/one failure). Both corrections
were independently re-reviewed and accepted with **58 passing tests** and no remaining findings.
Initial and corrective dispositions are retained in `docs/reviews/`.

Root's final installed-dependency checks returned exit 0:

| Check | Result |
|---|---|
| Stage zero | Ready, no installation |
| Registered `test:cr14c` | 183 passed |
| Registered pretest | 769 passed |
| Registered main test | 762 tests: 760 passed, two existing Windows-only skips |
| Registered posttest | 392 passed |
| TypeScript / full ESLint / cumulative whitespace | Passed |
| Private Node build / compiled artifact tests | Passed / 11 passed |
| Preserved Sites build / rendered artifact tests | Passed / 4 passed |
| Disposable migrations | 0001–0045 / 132 tables passed |

Tests do not establish actual PostgreSQL concurrency, physical transport, browser clicks, native execution
or a deployed private beta. Sites guidance preserved existing website/build configuration and dependencies;
the private Node/PostgreSQL architecture remains unchanged.

## Next

Continue on **Astra Medium** with trusted planner mounting, executable admission/approval/dispatch,
actual typed executor registration, then bounded revision handling. No ready transition, new attempt/lease,
dispatch, execution approval or provider call is created by this planner. Source/model/template selection
does not establish local ceiling, gateway/profile isolation or host qualification.

Physical transfer, real database/IdP setup, native pilot and deployment remain separately scoped gates.
No real database, listener, credential store, native/provider call, service, deployment or merge occurred.
The publication/current-head checks are in `BUILD_STATUS.md`; repository acceptance is not GitHub CI.
