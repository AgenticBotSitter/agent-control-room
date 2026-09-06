# Quality completion coordinator mounting

2026-09-05. Repository integration, not deployment or live fleet acceptance.

## Delivered behavior

The bounded task coordinator now optionally owns a scoped `quality.reconcile` operation. It reads the
exact authenticated native result, records configured deterministic document checks, reports waiting,
requested changes, failed verification or supersession truthfully, and calls the accepted atomic native
completion service only when the Completion Gate is ready. Exact replay does not repeat execution,
completion transitions or lease release. Structure checks do not replace independent quality review.

Each constituent SQL transaction rechecks tenant/workspace/project/job/run scope and locks the project
against reassignment. Existing run, review-plan, target/profile, returned-byte and checkpoint integrity
checks remain authoritative. Verification can commit before a later completion stage fails; that
evidence remains recorded and the outcome is not reported as complete. Explicit exact reconciliation
is available; there is no retry loop or new dispatch authority.

Configuration keys, rule arrays and supplied storage/checkpoint capabilities are captured before
asynchronous startup/admission. Quality keys must match the planner and private result/review views.
Invalid configuration fails before opening either pool. Both actual fixed-role preflights precede
application installation. The lifecycle/application/bootstrap return only the optional scope-bound
command to trusted server composition, never raw pools or keys. There is no HTTP quality endpoint.

Quality shares bounded admission, graceful drain, cancellation, forced-close uncertainty and retained
handle invalidation with planning/assignment. Clock validation rejects invalid values before SQL and
retains high-water across calls. Absent configuration exposes no quality capability.

## Database boundary

Migration0054 adds one inert native-run lock column and a coordinator-only completion-record trigger.
The offline coordinator profile gains reads of authenticated run/history/review-plan/artifact metadata,
inert record locking, service-verification INSERT and gate-integrity CAS columns. Its trigger permits
only the fixed document-verifier service, passed/failed evidence and false approval/execution flags.
It cannot insert human/agent checks, reviews, profiles, targets, findings, revisions, approvals, native
run/events or artifact records. The private web role is unchanged. Exact schema fingerprint and
positive/negative role checks cover the new catalog; disabled guards or extra/missing grants fail.

This is disposable PGlite evidence using actual restricted roles. The tests adapt only the known
PGlite database-TEMP metadata limitation; unmodified preflight is explicitly rejected. They do not
prove physical PostgreSQL connections, production concurrency or a provisioned database. Schema is
0001–0054, still138 tables. Operator setup remains a separate gated activity, not a startup migration.

## Review and verification

Production revision `274d2738872959c4d4766379159940824312f786`, tree
`3b116355d5402e1608274050bb9fd65a92626bfb`, adds the defensive nonnegative clock fence to initial
implementation `b76d125dad725ccb07696abf4cbded4fa3cde534`. Subsequent commits add tests and documentation.
Independent review accepted integration `81765e7ede4360c2c82b242d4e10e89f368fc2a1` with no remaining
actionable findings. The reviewer independently passed63 checks:39 existing lifecycle/role/startup,
19 quality/clock and5 final startup/drain tests. The test-only compiled follow-up at `8fbf6fe` was
also independently accepted and passed2 checks against the final root build, for65 independent checks.

Retained corrections: the first role-test run passed11 and failed2 because a negative-grant fixture
used `payload` instead of the actual review-plan column `plan` (one child and its parent). Corrected
and expanded tests subsequently passed all18 in one root run. The new clock regression passes
separately. Startup-test draft assertions were aligned with actual replay/receipt response fields
before its first reported successful5-test run; no production behavior was changed for those assertions.

The first compiled smoke run passed browser exclusion but its direct test-observer lease read was
denied after the protected HTTP review: the shared PGlite backend retained the web session identity.
Runtime startup and quality reconciliation had already succeeded. The corrected observers use the
explicit coordinator client/CanonicalStore, without resetting roles or widening permissions. The final
test records actual non-superuser session identities at both preflights and quality/review inserts,
then proves exact completion, replay, one artifact/native execution and bounded shutdown. Both new
compiled tests passed in the agent, root and independent-review runs. This is not browser-click evidence.

Final verification (all commands used already-installed dependencies; no installation):

- CR14C integration:665 passed, zero skipped or failed.
- Default main suite:1,160 passed, two existing platform skips, zero failed.
- Preparation suite:770 passed; post-suite:392 passed. These unchanged suites passed before the
  final defensive clock-only product correction; final CR14C/main cover that correction explicitly.
- Both builds passed. Private compiled checks20/20; rendered checks4/4.
- Disposable migrations0001–0054 verified138 tables and the exact schema fingerprint.
- Final TypeScript, full ESLint and whitespace checks passed.

This evidence accepts the repository block. It does not replace current-head GitHub CI or authorize
dependency-order merges, host setup or deployment.

## Still separate

The trusted quality command is mounted, but result/review event routing to it is not. Upstream
workflow/request completion, bounded revision creation/submission, runtime registration/recovery,
owner signing custody and physical agent/result transport still need their accepted integration.
This block creates no background timer, native/provider call, listener, credential access, installation,
production SQL, DNS change or deployment. Local passing tests do not establish a running private beta.
Current-head GitHub CI and dependency-order integration remain required; no merge is claimed here.
