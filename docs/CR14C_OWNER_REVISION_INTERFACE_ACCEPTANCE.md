# Protected owner revision interface: acceptance evidence

2026-09-05. Production `79ef608` plus correction `de949e7`; integrated evidence
`2691528` is independently accepted. Contract: `CR14C_OWNER_REVISION_INTERFACE_CONTRACT.md`.

## Implemented

The protected result view passes the actual producing run into the matching owner's saved
review. **Prepare revised task** uses its recorded feedback to create or reconcile one
linked proposed revision. A confirmed link opens that task's own page. Source result and
quality history are preserved; assignment and approval remain separate.

The new optional HTTP operation reaches the existing bounded coordinator and planner
through the separately owned two-role application. Request and receipt validation bind
the source job, run, target and digest, result bytes, review and feedback. Revoked sessions,
cross-origin requests, malformed input, extra authority fields and caller-selected retry
keys are refused. Ordinary one-pool startup cannot inject revision planning.

Page-owned review sessions retain exact revision bodies after lost acknowledgements and
later authorization failures. Only explicit checking repeats a write. Saved links are
conditioned on the matching current protected review; no browser persistent storage is added.
Reloading requires reading the saved review again and explicitly reconciling that same plan.

## Independent lanes and retained corrections

Root owns product/contract/integration. Separate agents authored backend HTTP tests and
browser/compiled tests; a third reviewed product and integrated evidence. The delegation
skill kept their writes limited to isolated evidence files. Sites guidance preserved the
existing application rather than introducing another deployment or storage architecture.

The reviewer found one strict-contract mismatch in the initial product: a caller retry-key
header was ignored rather than refused. Root correction `de949e7` rejects nonempty and empty
headers with 400 before planning. Narrow re-review accepted it; final tests cover both cases.
No other product findings remained.

The initial root compiled suite passed25/failed1 because an earlier internal-only test
forbade the now-public receipt literal `requires_separate_assignment_and_approval` in browser
assets. The independently reviewed test adjustment permits and positively asserts that
literal while retaining all private planner/schema/method exclusions. The corrected suite
passed26. This failure is not concealed as a passing initial run.

The browser lane made one focused test-only syntax/unused-import correction before final
validation. The backend lane had no fixture failures. Its sandbox could not write Git
metadata; root applied the exact reviewed correction and committed the finished test file.
No native attempt, permission change or runtime repair occurred.

The broad default run initially passed five lanes; main-4 had364 passed, two failed and
one existing platform skip. Both failures asserted the obsolete blanket revision-not-connected
copy. Root correction `ae000a1` checks the new separate-assignment/approval wording and
adds explicit absence of the prepare button for those disconnected/unmatched/history
fixtures. No production behavior or private-boundary assertion was removed.
The corrected legacy browser file passed all seven tests. The full original main-4 lane
then passed366 with one existing skip in170.29 seconds; zero failures/cancellations.

## Verified evidence

- Stage-zero macOS preparation passed with the unchanged frozen lockfile and installed dependencies.
- Isolated final backend HTTP tests: seven passed; TypeScript and scoped ESLint passed.
- Isolated browser/state tests: seven passed. Compiled private-interface tests: two passed.
  Their combined nine tests, private build, types and scoped lint passed.
- Root integrated three new files:16 passed, zero failures/cancellations/skips in13.66 seconds.
- Root TypeScript and full ESLint passed. Both existing application builds passed; after the
  header correction the private build was repeated and all26 existing compiled tests passed.
  Together with the two new compiled tests,28 compiled tests passed.
- Rendered HTML: four passed. Disposable migrations0001–0054 verified138 tables. No SQL
  schema or privilege changes are part of this block.
- All three new files are registered without removing prior commands; the default lifecycle
  now contains272 files. Eight deterministic inventory checks passed.
- All six prior270-file default lanes passed after the retained copy correction:2,504
  passed and two existing platform skips. Counts: pre770, main-1 267/one skip, main-2 359,
  main-3 350, main-4 366/one skip, post392. This run began before the one-line header
  correction; the final integrated16 separately prove that correction's exact interface.
  New default files were verified separately before registering the expanded272-file inventory.

Browser evidence covers clients, page-owned command state, static panel rendering and
component props. It does not mount the full owner controller through browser focus,
read failure and close/reopen events. Current-read hiding and absence of focus-triggered
writes are independently supported by source review, not a newly observed DOM journey.
Compiled tests use real protected HTTP, actual restricted disposable SQL roles and a
browser client against the compiled handler, with synthetic native events and fake transport.
They are not a physical PostgreSQL rehearsal, live bot or observed browser-click acceptance.

Prerequisite PR #335 at `1c6b5d4` passed all nine GitHub jobs, including the aggregate gate,
in run `34011391526`. This block still needs its own current-head CI and dependency-order
integration. No merge or deployment is included.

## Remaining

Trusted runtime result registration/submission ownership, owner signing and recovery,
real database/host preparation, and the first supported live task remain. The separate
upstream workflow/request completion gate is unresolved; excluded draft PR #329 is not
adopted or re-reviewed. The overall CR14C live-use exit remains incomplete.
