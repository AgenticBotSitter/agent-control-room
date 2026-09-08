# Overnight continuation — 2026-09-08

New continuation observed at 04:40:58 UTC; stop by 12:40:58 UTC. The product goal's
accumulated counters include prior work and are not treated as this run's elapsed
time. Do not extend this window on subsequent continuations.

Scope: local implementation/testing/review; batched sanitized private branch
transfer only. No production changes, live provider calls, authentication capture,
persistent services, public publication or Actions dispatch. Preserve the two
uncommitted setup notes and unrelated poster.

## Active work

- Independent source review of the website-only startup/configuration at 5e99c37.
- Read-only migration/role source inventory for deployment, with deterministic
  hashes and rejection of missing/duplicate migration sequence numbers.
- Correct preparation/backup/restore ordering in the deployment procedure.

## External gates

Database durability, actual backup/restore, supervisor installation, real owner
authentication and production-start acceptance remain external gates. They do not
prevent local work. No live gate is accepted from a mock or a source inventory.

## Next

Independent source review found a P2 mutable listener-port read after asynchronous
startup. Port capture and a mutation regression were added, together with bind
failure/cancellation cleanup tests. Migration inventory's six tests and focused
lint passed. No production action was performed.
All 16 combined inventory/launcher/website-start tests and focused lint passed.
The independent reviewer rechecked the port correction and reported the original
finding resolved with no remaining concrete finding in that remediation. This is
source-only review plus local injected tests, not VPS startup acceptance.

Review findings, implement concrete corrections, test and record the disposition.
Then inspect actionable project/Idea/ABS integration gaps against existing source.

## Idea project lifecycle integration

The suspected Idea discussion navigation-state issue was already prevented by
route keys; no navigation change was retained. Independent investigation instead
confirmed the private project view had not connected the existing Idea lifecycle.

Connected that existing service through a scoped, revocable transaction and durable
browser command receipts, added a private route, authorized action projections and
Settings controls. Added narrow SQL grants and matching strict preflight. No new
schema migration, provider call or production SQL execution.

Independent review identified resume/reopen permission interchangeability in the
existing domain service. Added source-state enforcement after historical replay and
both restricted-grant regression cases. Re-review reports resolved with no additional
concrete finding. Source-only review is not independent runtime acceptance.

Initial bridge/browser/restricted-role tests passed (11 before the rendered-control
test was added). The omitted-grant negative test first failed because its synthetic
session reset did not select the setup owner; corrected to the fixture's explicit
setup identity and verified the privilege really became false before testing rejection.
The corrected negative test passes. TypeScript, focused lint, VPS compilation,
42 related regressions and 23 existing lifecycle/registry/compiled checks passed.
Full Idea/ABS delivery validation and final rendered-control verification completed
as recorded below.

Final lifecycle tests: 12/12 pass, including rendered controls and cross-operation
command-key collisions. Full `test:idea-abs:delivery` exits zero, including its
239-test delivery stage. Full lint initially reported 1,081 errors in generated
`dist-contributor` output. That directory is the configured contributor Vite output
and already gitignored; added its exact directory to ESLint's existing build-output
exclusions. Verified both contributor and private source remain linted. Full lint
and a fresh VPS compilation now pass; existing middleware/dependency bundling
warnings remain warnings, not silently claimed fixed.
All 49 compiled VPS tests pass sequentially against the fresh artifact. This batch
has local source, rendered-control, restricted-fixture and compiled-route evidence,
not an owner-attended browser session or live VPS acceptance.

Deployment delta and caveats: `IDEA_PROJECT_LIFECYCLE_DELIVERY.md`. Preserve the
unchanged 12:40:58 UTC deadline and all external production gates above.

## Database-only preflight and deployment handoff

Added a thin operator command around existing production database validation and
bounded cleanup. It does not install the app, fetch JWKS, bind a listener or write
application data. Read-only means performed SELECT queries, not an arbitrary-SQL
read-only session; existing preflight requires a writable primary. Its receipt
explicitly leaves backup verification and production readiness false.

Added ordered PostgreSQL-tool backup/restore instructions, a conditional systemd
review template and maintenance-update procedure, and one consolidated Johnny5
handoff. Actual namespace/supervisor, persistence, target provisioning, real owner
login, backup/restore and production start are still external gated work. The
minimal operator profile does not magically configure Idea/News keys or agents.

Independent source review found no concrete defect and requested separate cleanup
branch coverage. Added passed-check/failed-close and failed-check/passed-close tests;
follow-up review reports no concrete mismatch, including in the supervisor template.
Its template test is a source-contract check, not Linux/systemd acceptance. Official
PostgreSQL and upstream systemd documentation informed the procedures; no production
commands or downloads were executed. Full lint, TypeScript, focused checks and a
fresh VPS build pass. Compiled database-check/startup regression verification follows.
Final verification: seven focused database/CLI/cleanup/template tests and 21
compiled/startup/launcher/lifecycle regressions pass. The compiled check leaves
the actual compiled handler uninstalled (503) before and after checking its
disposable database. A key-loader trap confirms no login-key fetch. No native
PostgreSQL connection, actual restore, supervisor install or listener was attempted.

## Expired-session recovery across Idea Lab and news

Found 13 Idea/news request sites missing the explicit AJAX expiry header already
used by project/task clients. Added it without changing cookies, redirect rejection,
timeouts, server JWT checks or MFA. Cloudflare documents this mechanism at
https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/session-management/.

Idea creation/decision and news draft/save/settings/archive/refresh messages now
distinguish expired login and preserve an earlier uncertain save. Guidance keeps
the original tab open while signing in elsewhere; no automatic write retry or
browser persistence was added. Source audit covers 24 currently matching client
and top-level private component fetch calls; it is not a guarantee about future
wrappers/nested components or real Cloudflare edge behavior.

Four dedicated tests pass, including uncertain Idea save and initial-versus-later
401 responses across archive/source/refresh clients. Independent source review
reported no concrete defect, noting the source-audit and live-edge coverage limits.
TypeScript, full lint and fresh VPS compilation pass. Full delivery command passed
including its 239-test stage; final Idea/ABS base rerun covers the last recovery-copy
changes. Compiled/private-browser regression checks also follow. Real owner login
acceptance remains gated, not established by simulated 401 responses.

After handoff, the earlier final-check output was unavailable. A process inventory
confirmed those tests were no longer running before fresh verification: Idea/ABS
base 88/88 pass, compiled handler/startup and browser regressions 19/19 pass.
TypeScript and full lint pass again. No open PR targets this working branch;
publication remains a private batched skip-CI push, with no merge or workflow run.

## Startup configuration and remaining workflow audit

Independent read-only workflow tracing at 83b15c5 confirmed existing Idea
create/start/stop/synthesize/decision/promotion and ABS source/task-save paths.
It found three genuine gaps, distinct from missing production configuration:

- Idea Start waits for full execution while the browser request times out after
  ten seconds. The detail page needs bounded read-only progress refresh, without
  replaying Start or losing pending decisions. Local implementation is recorded below.
- ABS refresh approval displays an historical receipt, but no subsequent collection
  completion/failure read. Reuse the retained feed plan and canonical job/effect
  records for a scoped status view; do not treat collection jobs as ordinary tasks.
- Idea participants are fixed by server configuration. Owner roster selection
  would need authorized options drawn only from that configured roster, not
  browser-supplied provider descriptors or identities. This remains unimplemented.

The website-only validator previously silently discarded approvals, submission
and queue-attention callbacks. It now rejects their presence, matching existing
coordinator-operation exclusions. Both ordinary startup and database-only check
reject before effects. Independent review confirmed legitimate task composition
adds these operations later and is not broken by this restriction. Forty startup/
Idea/news tests and five compiled startup/database tests pass; typecheck, lint and
VPS build pass. These are disposable local tests, not production startup evidence.

Follow-through inspection found two news settings UI catches swallowed the new
authentication guidance. Added a typed, locally generated recovery error and
surface only that type in those screens; generic failures remain generic. Source
review found no defect and confirmed pending-save semantics remain unchanged.

## Idea progress observation

Connected a finite, non-overlapping saved-detail observer to the Idea workspace.
Visible active panels and locally requested starts get five-second checks, capped
at 180 automatic reads per mounted detail. Terminal state or authorization denial
stops automatic reads; explicit Refresh can check again. No command or provider
capability is passed to this observer, and the server's synchronous start operation
is unchanged. Observation does not constitute live-provider qualification.

Decision submission synchronously holds reads and invalidates an older outstanding
read, preserving its exact pending client. Errors render beside the retained
discussion instead of unmounting it, and manual refresh does not clear the detail.
Source review reported no defect and requested additional deferred cleanup tests.
Static-render/controller tests establish projection retention, not mounted React
form lifecycle acceptance. Real browser and real owner/provider acceptance remain
unperformed. An initial test callback type error was corrected; subsequent full
TypeScript, lint and fresh VPS compilation pass.

Final batch verification: Idea/ABS base 92/92 pass, eight fresh compiled startup/
database/handler tests pass, and all five observer tests pass after adding deferred
stop and hold-cycle races. Closing aborts the signal and suppresses late successful
or failed callbacks; releasing a hold cannot admit the pre-hold response. The
separate 40-test startup suite and 18-test news/recovery suite also passed. No live
browser, Cloudflare, PostgreSQL, provider or production test is claimed.

## News collection status

Connected saved collection status through the existing signed-plan/coordinator
composition, protected source route, strict browser client and progress UI.
Queued/running observations are finite and read-only with respect to domain work;
normal authentication may register a web session. No automatic approval or retry.
Completed links to saved news and does not imply new articles or verified research.

Independent backend review found unsigned JSON filtering could hide a corrupt
source plan. Removed that selection shortcut: bounded complete inventory integrity
verification precedes source/ranking selection. More than 100 project plans needs
an exact job ID; no silent partial result. Re-review reports the finding resolved.
Browser review found a stale empty-state flash after receiving a new job ID; command
completion now clears only the old status display, not its pending command memory.
The first corruption-test attempt was blocked by the append-only trigger. The test
now explicitly injects corruption only in disposable PGlite and restores it; focused
corruption and restricted-role tests pass. Full final verification is in progress.
Details and remaining scale/live-acceptance limits: `NEWS_COLLECTION_STATUS_DELIVERY.md`.

Final full delivery command exited zero, including its 240-test final stage.
TypeScript, full lint and VPS compilation passed. Ten focused browser/status tests
and eight compiled startup/handler/database checks also passed. The history-bound
fixture proves incomplete discovery refuses and exact lookup remains usable.
Final UI review additionally caught a passive-cleanup race; command completion
now stops the old observer synchronously before replacing its status projection.
Subsequent timer reads pin the discovered job instead of rescanning project history.
Final focused/rebuild checks cover this correction; no production effect occurred.
The final correction passes six focused status tests, TypeScript, full lint, a fresh
VPS build and seven compiled handler/startup tests. No test was weakened to convert
an uncertain collection into success.

## Idea participant choice

Connected safe configured-roster options through the existing coordinator and
protected application, then added the New Idea chooser. The existing contract
requires three to six distinct perspectives including a skeptic; it is not relaxed.
Each choice binds the server descriptor digest, not a browser-supplied identity or
connection. Exact retries recover the saved roster across deployment changes.
Options/reloads cannot replace pending request bytes or trigger execution.

Independent backend and UI reviews found no concrete defect. Eighteen focused
creation/startup tests passed; a separate injected start proves only the selected
three participants are invoked and replay is inert. That test initially assumed
the helper returned its session; it was corrected to read the actual saved session
through the application service. TypeScript and full lint pass. Full delivery and
fresh compilation are running. See `IDEA_ROSTER_SELECTION_DELIVERY.md` for scope
and live-browser/provider evidence limitations.

Final roster batch: full `test:idea-abs:delivery` exits zero including its 240-test
final stage. After strict options-response serialization, TypeScript, full lint,
fresh VPS compilation and 21 compiled-handler/startup/Idea-startup tests pass.
No open PR exists for the private working branch. Batched publication uses skip-CI;
no merge, workflow dispatch, credential access or production action was performed.

## Bounded saved collection history

Added authenticated history pages using the existing signed plan store, rather
than a second history index. Pages verify 25 project records and then filter by
source. Empty filtered pages retain a forward cursor. The browser replaces one
page at a time and selects exact saved status without changing pending commands.
Automatic latest discovery retains its 100-plan ceiling.

Independent backend review found database-default sorting could disagree with
JavaScript cursor ordering for mixed-case/punctuation IDs. Both SQL cursor
comparison and ordering now explicitly use C collation. A real disposable signed
store traversal covers 108 plans, an empty first source page, five pages without
duplicates/skips, and exact status beyond the discovery limit. Its first run used
an overly broad fixture scope and failed strict validation; the fixture now passes
only the store's three scope fields, with no production contract change.

Independent UI source review reports no concrete defect; mounted React races and
live provider/browser operation remain unverified. The first focused combined run
passed 67 tests. TypeScript, full lint, fresh VPS compilation and seven compiled
handler/startup checks pass. Additional mounted route, corruption and restricted
role assertions pass in the full delivery run, which exits zero with 241 tests in
its final stage. Backend re-review confirms the collation finding resolved. No
open PR exists for this branch; no CI, production or provider action was taken.

## Project-to-discussion return navigation

The existing signed project registry already retained its originating session;
the private projection now exposes it only with workspace-wide owner discussion
read permission. The project page links to that existing protected discussion.
Ordinary projects and narrower project grants omit the field, and archive/reopen
preserves provenance. No database schema, new index or provider work is added.

Independent source review found no defect and suggested isolating the wildcard
permission case; the regression now gives session-read plus project-read actions
but only one project scope and confirms no link disclosure. Initial navigation
test incorrectly assumed a top-level project/decision digest in the wire response;
it now follows the existing decision.project and compares the returned decision.
A second test-only correction unwraps the project API's existing project envelope.
Final combined catalog, Idea navigation, lifecycle, restricted-role and compiled
handler/startup run passes all 30 tests. TypeScript, full lint and fresh VPS
compilation pass. These are disposable API and static-render checks, not owner
browser or production acceptance. No new schema/role/production change occurred.
