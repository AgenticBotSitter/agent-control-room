# CR14C current recovery-policy evidence

Date: 2026-09-05. Status: independently accepted unwired component; local verification passed.

Product head: `7a169755b2e4f9b29d38dda255ba3acf3d4c57a4`.
Base: `4f32ef1891490b475282ddcbe575b69be6cae9e9` (PR #306).

The first focused run passed 39 tests covering recovery/current-work composition. A subsequent
same-revision conflict regression was added before the review head. All owner keys are generated test
keys; native transport and local credential/cleanup state are explicitly synthetic. The tests use the
real owner-pinned security repository, retained trust updates, public approval resolver, native run
journal and durable claim/execution controller. They do not qualify a host or prove physical stop.

Coverage includes separate approval resolution without a work ceiling, exact known-run stop after
deadline, no restart permission, profile-await revocation/closure, current trust change, wrong scope or
credential reference, backwards revision, same-revision conflict, invalid booleans and aborted reads.

Independent review accepted the exact product head with no actionable findings across all six changed
paths. The four-file review suite passed 46 tests, with zero failures/skips/cancellations. Accepted tree:
`7320e00c5ceea2e22b71c312db98ff476a803049`.

CR14C passed 346 tests; preparation passed 769. TypeScript and full ESLint passed. Private application
build and 16 compiled tests passed; Sites build and four rendered tests passed. Disposable migration
verification through 0046 passed with 132 tables. Main suite passed 925 tests with two existing platform
skips; post-suite passed 392. Whitespace checks passed. No negative test run occurred in this block.
No live credentials/provider calls, listeners, production database, deployment or merge occurred.
See `CR14C_CURRENT_RECOVERY_POLICY_CONTRACT.md` for remaining trusted integration seams.
