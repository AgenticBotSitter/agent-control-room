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

## Installable saved-data capabilities and mode correction

The operator module now optionally maps protected savedViews hexadecimal keys to
the existing Idea/news services. The minimal settings shape remains valid. It
generates no keys, starts no collectors/providers and supplies no coordinator.
These services permit existing authorized saved-record actions; they are not a
read-only database mode. Private configuration and key custody remain operator work.

Source inspection found website-only mode could accept Idea runtime or top-level
news worker settings despite its disabled-execution message. Both are now rejected
before asset/host acquisition; non-executing saved web services and Idea creation
configuration remain permitted. Independent review of both changes found no
concrete defect. Fourteen combined launcher/compiled-startup/handler tests pass,
including protected synthetic settings through compiled Idea/news routes and
pre-acquisition runtime rejection. TypeScript and full lint pass. Synthetic trust
is injected; no actual JWKS/provider/database/server operation is inferred.

Remaining meaningful source assembly: make non-executing Idea creation available
without requiring unrelated handwritten native-task planning/checkpoint resources.
Reuse existing creation/coordinator services and role gates rather than inventing
another discussion runtime. Actual agent admission resources remain private/live
gates, not permission to substitute fixtures in production.

## Saved news deep-link correction

Before starting the larger authoring composition, source tracing found the HTML
news guard rejected view/order query parameters already emitted by the UI and
accepted by the API. It now accepts the exact three visible views and sorts,
passes them to the existing authorized news read, and uses the page's same
history/important defaults. Duplicate, empty, unknown and API-only options remain
rejected. No news fetching or command behavior changes.

All nine combinations reach the protected shell; anonymous and malformed requests
do not. The first expanded test retained a stale final render count of one; that
expectation now reflects the nine added authorized renders. Final combined news,
compiled-handler and startup verification passes 20 tests. TypeScript, full lint
and fresh VPS compilation pass. Independent source review reports no defect;
this is route/static evidence, not a live browser interaction test.

## Non-executing Idea authoring installation

Added a narrow two-role startup joining the existing web request admission/drain,
bounded pools, Idea creation, deterministic recap and owner-decision services.
It avoids requiring unrelated task-planning/checkpoint configuration. The compiled
entry and existing launcher accept explicit protected ideaAuthoring settings with
the same saved-record key, distinct restricted writer login and validated roster.
No runtime, queue, task planner, provider, stop or native listener is configured.

Independent review caught cleanup dropping a distinct pool wrapper when its client
aliased another handle. Cleanup now deduplicates actual handles instead; the
regression confirms both cleanup obligations run. Re-review confirms the fix and
reports no concrete wiring defect. Invalid topology/roster, failed role preflight,
cancellation and install failure checks pass. The compiled settings test initially
included extra fields from a broad fixture object; it now selects only the existing
documented web fields rather than weakening the settings parser. It passes through
the actual operator, authoring bootstrap and launcher with synthetic trust and
injected listener; exactly two pools serve saved Idea options/save/read.

Source-only role tests use the existing PGlite fixture accommodation; they do not
prove independent physical connections or production deployment. The web-only
database checker does not verify the new writer role; documentation now says so.
Full Idea/ABS delivery verification exits zero with 241 tests in its final stage;
the new seven authoring startup tests are included in the lifecycle stage. Twelve
compiled/operator/launcher checks pass, along with TypeScript, full lint and a
fresh VPS build. No private input was read,
no production schema/role was changed, and no native/provider call occurred.

## Two-role database-only deployment check

The preceding web-only checker limitation is now resolved. Authoring startup and
the database-only command share configuration capture, acquisition, both role
preflights and bounded cleanup. The checker constructs no application services,
installs nothing and reports acceptance only after both connections close. Its
receipt explicitly leaves backup verification and production readiness false.
The existing protected operator command selects this fixed compiled operation
when authoring is configured; the original web-only path remains available.

All 21 combined source and compiled checks pass, including close failure, failed
role preflight, canceled startup and protected operator selection. TypeScript,
full lint and fresh VPS compilation pass. Independent source review found no
concrete regression. The repeatable authoring build command includes the new
command and compiled database-check tests. These are disposable local fixtures,
not evidence of live PostgreSQL readiness or permission to access production.

## Needs Me and keyboard navigation repair

The shared Needs Me shell previously required connection-inventory access even
for an owner authorized to use the independent task inbox. It now accepts either
existing owner permission path, with wildcard scope and precommit freshness checks.
The recovery and task endpoints retain separate unchanged data permissions. No
task or connection permission is granted by opening the shell. Regression cases
cover task-only and recovery-only owners, missing/partial permissions, project-only
scope, operator denial, malformed queries and logout.

An independent worker added the missing private-main skip-link targets to Idea
list/detail and news shells. Static rendering verifies exactly one main target
per shell; actual keyboard focus remains browser-unverified. Main reviewed the
patch. Independent source review found no authorization regression in either
change. Nine focused navigation checks and 24 broader task/process/compiled checks
pass, as do TypeScript, full lint and fresh VPS compilation. The new repeatable
test:private-navigation command covers the focused cases. Recovery denial copy
still says owner access is required for owners missing that permission; this is
a wording limitation, not additional authority or a bypass.

## Authoring deployment inventory and restore completeness

The explicit idea-authoring source inventory now includes the writer-role SQL in
addition to all migrations and the existing web files. The default inventory is
unchanged. CLI tests reject unknown profiles and extra arguments; writer source
changes alter the digest. The first CLI regression failed because the test used
a URL pathname containing encoded spaces as a filesystem path; fileURLToPath fixes
the test invocation. All eight inventory checks, TypeScript and full lint pass.

Deployment instructions now identify separate writer-role provisioning and
cluster-wide role collision review. Restore acceptance must preserve the deployed
authoring profile, keys and roster, retarget both distinct logins to the same
disposable restore and require both role checks. Independent deployment review
identified the restore ambiguity; independent final source review confirms the
inventory and corrected instructions have no concrete mismatch. No SQL was run,
no archive created, and no production inputs accessed.

## Accumulated delivery verification

At a834aca, `pnpm test:idea-abs:delivery && pnpm test:idea-authoring:build`
completed with exit zero. The latter rebuilt the VPS artifact and passed all 24
source/compiled/operator/launcher checks. The former completed the full sequential
memory-safe Idea/ABS pipeline. This validates the accumulated local changes;
it is not a new VPS installation, backup rehearsal or live provider acceptance.

## Fresh authoring promotion prerequisite

The independent worker extended the compiled operator/authoring test beyond save
and read. Synthetic completed turns and compiled recap/replay passed, but compiled
project promotion returned 503 because the fresh fixture lacked the native Idea
adapter registry row required by the project foreign key. Older seeded fixtures
supplied that row manually. This was a genuine untested installation prerequisite,
not an assertion to remove or an excuse to give the writer broader privileges.

Added separately executed, inventoried native-adapter setup SQL requiring an
explicit session-only tenant setting and an existing tenant. It inserts a pending
registration and refuses collisions without overwrite. Authoring and full task
startup now read-check the fixed adapter's tenant, version, source, native authority
mode and non-disabled state through the existing web role. They never provision
or repair it. Existing role privileges and all 64 migrations remain unchanged.

The shared disposable startup fixture executes that actual setup SQL. The compiled
path now completes recap, decision/project promotion, exact replay, project-origin
read and deep-link admission with unchanged job/outbox counts. Synthetic records
remain explicitly injected-only; no fake driver is installed in production code.
The initial test-only session-auth reset remains a documented PGlite accommodation.

All 34 focused source/compiled/setup tests pass, including full-task missing-adapter
cleanup and authoring missing/mismatched/disabled adapter refusal. Setup rejects
missing tenant input and duplicate registration without changing the original row.
Independent source review found no concrete defect and requested the full-task
cleanup case, now passing. Setup guidance and restore requirements are updated;
actual execution still needs exact-target authority. The earlier full-delivery
pass predates this prerequisite correction and is not represented as its full run.
The final eight inventory checks, TypeScript and full lint also pass; the compiled
promotion regression uses a fresh VPS artifact built from the corrected source.

The full sequential Idea/ABS delivery and authoring build pipeline subsequently
passed at eef319e, with all 25 authoring build checks passing. This supersedes the
previous full-run caveat for that correction, not the remaining live gates.

## Verified owner bootstrap bridge

Critical-path inspection found meaningful local glue missing between the existing
Access verifier and one-time SecurityStore owner bootstrap. The new deployment-only
bridge composes those existing components with a separately confirmed subject digest,
captured trusted configuration and a borrowed provisioning connection. It requires
the reviewed database name and existing tenant/workspace, verifies before database
access, and checks authentication/clock/cancellation again before commit. It never
selects an owner from the first valid token or changes an existing owner.

The compiled server entry is explicit and not mounted in the website or loaded by
the launcher. Private assertion intake, real identity confirmation, trusted keys,
MFA inspection, provisioning connection acquisition/cleanup and execution authority
remain operator work. OWNER_BOOTSTRAP.md documents these limits. No production
credential, database or owner login was accessed in this block.

Independent source review found no concrete security defect and requested additional
trust-expiry, grant-write failure and lost-commit-response cases. Those now pass:
expired trust and grant failure roll back identity/grant writes, while a lost commit
acknowledgement reports failure and consumes the attempt rather than retrying. Local
tests also cover wrong subject/audience/token type, scope refusal, config capture,
concurrent use, pre-abort and unchanged existing tenants. All thirteen final combined
source/compiled/startup checks pass, including browser-artifact isolation. TypeScript,
full lint, final focused lint and VPS compilation pass.

## Executable owner setup and restricted website handoff

Added the explicit owner-bootstrap operator command using the existing argument
and protected-path guards, fixed compiled entry and bounded PostgreSQL adapter.
Provisioning input uses a separate operator-controlled file/module, not runtime
website credentials. Pinned identity verification precedes connection acquisition;
the bridge rechecks before writing/commit, and successful reporting requires owned
connection closure. No website or supervisor calls this command automatically.

Independent review found the command and bridge initially had separate clock
high-water marks. They now share one across acquisition and commit; the acquisition
rollback regression refuses creation and closes the acquired pool. Source re-review
confirms that correction with no remaining concrete issue. Documentation requires
a provisioning checkout and imports not writable by the web service, independently
confirmed identity, approved target and explicit production-write authority.

The compiled journey now continues from owner creation through actual restricted
web-role preflight, authenticated project creation/read and logout/revocation. Every
application query asserts the restricted login; provisioning never substitutes an
admin connection for app requests. The first logout expectation used 200, corrected
to the existing 204 contract. All 17 combined source/wrapper/compiled checks pass,
as do TypeScript, full lint and a fresh VPS build. No real assertion, provisioning
connection, native listener or production write was used.

## Full task database inspection without task startup

The complete sequential Idea/ABS delivery, authoring build and owner-bootstrap
build pipeline passed after the owned owner command; its final owner suite passed
17 checks. This is local evidence only, not a VPS rerun.

Independent critical-path inspection identified that the database-only command
could not inspect a full task deployment. Added a fixed compiled task database
checker using the existing complete task validator and exact role preflights.
It covers all configured task, Idea, queue and news logins without constructing
services, preparing submissions or starting workers/listeners. It takes ownership
only of the pools it acquires, not supplied inert runtime/checkpoint/transport ports.
The same protected operator command routes explicit full-profile input to this
checker, retaining the launcher's required mode fields rather than quietly reducing
the configuration to website-only. Operator modules remain trusted code; their
configuration factories must be inert and exact database access separately approved.

Independent source review and final CLI re-review found no concrete defect. Initial
combined source, wrapper, compiled and existing startup regressions passed 34 checks,
plus TypeScript, lint and fresh compilation. Actual restricted-role fixtures cover
two-role and three-role Idea profiles; the optional remaining role combinations
are source-reviewed, not claimed as newly executed full-fleet qualification.
Alias, cancellation and cleanup failure cases return no acceptance. The compiled
handler remains unavailable before and after inspection. Later tests add invalid
topology refusal before acquisition and coordinator failure before Idea acquisition.
All nine final focused source checks pass with those additions.
No live database contact, SQL provisioning, provider or production effect occurred.

## Keep exact task saves through authentication recovery

Independent journey inspection confirmed the normal news-to-task and Idea-to-project
links already exist. It found a concrete recovery defect instead: the task page
offered a same-tab Access logout link after an expired session, destroying its
memory-only pending command keys and review/verification state when followed.

Reused the existing keep-this-tab authentication guidance and navigation guard.
The task page now holds link navigation and requests a browser leave warning while
a proposal, review, revision or human-verification save is in flight/unconfirmed.
Page-owned workspaces expose aggregate pending state even while protected result
subtrees are removed. Protected read failures still clear displayed results, not
the retained exact command. Confirmed proposals release the busy hold before their
normal success navigation. No browser storage, new authentication stack, background
write/retry or additional authority was introduced.

Independent source re-review found no concrete regression in this scope. All 31
focused recovery/review/revision/verification checks and six compiled protected
handler/review/revision checks pass, plus TypeScript, full lint and a fresh VPS build.
The new lost-save/401/recovery test retains identical request bytes and key and
releases navigation only after a matching receipt. Tests use injected browser
events/static rendering, not a mounted live browser or real identity provider.
Browser close warnings cannot guarantee preservation after a forced close/crash.
Nested planning/assignment/submission command protection remains outside this
particular navigation test scope. Sites guidance kept the existing interface and
local-only delivery; no browser handoff or hosting was performed during background work.

## Retain queue submission across ordinary status refresh

The follow-up source audit confirmed a second real recovery defect: each new task
detail object briefly makes the approval read non-current, unmounting the submission
panel. That panel previously owned its submission client, so an ordinary refresh
could discard an unconfirmed queue command. Its initial read also labeled a null
receipt as not recorded even when a retained client still held uncertainty.

Moved execution clients to the stable task page, reusing the existing bounded
page-workspace pattern. Planning, assignment and approval share that page lifetime;
submission clients are retained by exact project/job/input/packet binding, bounded
to 128 without eviction. Protected reads still gate rendering and actions. Null or
denied submission reads retain uncertainty, while only matching canonical readback
resolves it. No automatic POST retry, browser storage or new permission was added.
The page navigation guard now also sees all these retained execution commands.
Approval digest preparation is included in the pending hold because that asynchronous
step can continue into a write even before its pending identity has been allocated.

Thirty focused execution-client/panel checks initially passed; TypeScript passed,
then lint caught JSX construction inside a try/catch. The guard now catches only
client acquisition, with JSX outside the catch. The expanded task-recovery suite,
18 compiled protected handler/approval/startup/review checks, TypeScript and full
lint subsequently passed with a fresh VPS artifact. Independent source review
confirmed retention fixes with no concrete new defect. Fixtures exercise the actual
read-gated panel projection and retained clients, not a mounted browser refresh.
All live fleet, owner-signing and production acceptance gates remain outstanding.

## Join article discovery to the exact completed research task

Closed a synthetic integration evidence gap rather than implementing another
collector or executor. The existing borrowed Control Center collection receives
injected HTML/feed responses, stores the article, and the mounted private API
prepares its verification-first draft. The ordinary task-save endpoint saves and
replays that draft without starting work. An optional source-preparation callback
in the existing lifecycle fixtures carries this exact saved draft and its digest
through planning, assignment, signed approval and synthetic native execution.
The test checks the new source/execution lineage (not unrelated historical fixture
rows), protected result retrieval, exact output bytes, owner review, completion,
and replay with only one synthetic native start.

The first new test run reached the result but exposed an incorrect test expectation
equating source-draft and execution-input digests. Those are different contracts;
the corrected assertions check sourceInputDigest, exact prompt and execution digest
separately. The final focused journey including unauthorized/authorized HTTP result
reads passed 1/1. Existing canonical approval/lifecycle/quality regressions passed
56/56, TypeScript and full lint. Independent source review found no concrete defect.
The focused sequential command is `pnpm test:abs-research-journey`.
Its combined final run passed 61/61, followed by TypeScript and full lint.

Scope: injected collection authorization/transport, PGlite and in-process controllers,
synthetic owner/node credentials and structural document acceptance. This does not
exercise real browsers, pg-boss workers, PostgreSQL or providers; it does not verify
the truth of research conclusions. No runtime source behavior or production state
changed. Source preparation failure now closes its disposable base fixture.
