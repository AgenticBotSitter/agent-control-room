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

## Prepare initial work from a promoted Idea

Source audit found that promotion created the project but the task page offered only
blank fields, leaving the owner to copy the recap/experiment manually. Reused the
existing protected Idea read, schema-checked project view, editable task form and
ordinary exact-save client. The explicit preparation control is available only for
an active, proposal-eligible Idea project with authorized source-discussion metadata.
The returned decision must promote this exact project and all session/synthesis
bindings must agree. Draft text contains the experiment, recap and source digests,
labels synthetic contributions, and asks for a bounded experiment plan rather than
executing an experiment. The text is editable context, not authenticated authority.

Preparation performs only a read. Existing text/pending writes prevent replacement;
form edits/saves are disabled while it reads and stale responses are generation-fenced.
The actual save still requires an explicit owner click and the existing server checks.
No endpoint, permission, key, storage, dependency or provider path was added.

Two initial restricted-role mounted integration checks passed: prepare without writes,
reject invalid/mismatched source and missing login, then edit/save with a deliberately
lost response and replay the exact bytes/key into one proposed task with no attempts.
Static rendering verifies the editable form and preparation-disabled controls.
TypeScript, full lint and the two package inventory checks passed. Independent source
review found no concrete defect. Both new journey files are included in the standard
sequential Idea/ABS delivery path. Sites guidance preserved the established interface
and authentication; local background work did not deploy or open a browser preview.
The final combined sequential Idea/ABS and task-recovery suites passed, followed by
a fresh VPS build, 14 compiled handler/composition/startup checks, TypeScript and
full lint. This remains injected/static evidence, not live browser or host acceptance.

The audit also confirmed a larger remaining product setup limitation: the current
execution planner is pinned to one project's template and acceptance profile. A newly
promoted project does not inherit another project's execution authority. This initial
draft connection does not solve or conceal that separate configuration requirement.

### Resume checkpoint after private batch push

Private branch now contains `1d1ae90` (article-to-exact-research integration) and
`7f46251` (Idea experiment draft). Push confirmed; no open PR existed for this branch,
and the inspected workflows do not run on its push. No PR, merge or Actions dispatch.
Final regression session 76602 exited zero; no test process from this batch remains.
Original deadline stays 2026-09-08 12:40:58 UTC (clock at push: 08:06:42 UTC).

Next meaningful local block: one existing coordinator should support several
explicitly configured project templates, without granting automatic authority to new
projects. Independent source feasibility review confirmed the smallest extension is
a bounded extra-template list inside TaskExecutionPlanner, exact project selection
inside authorized plan/revise operations, plus immutable capture in private task
startup and result-coordinator reconstruction. Preserve profile/digest/expiry checks,
same-source replay, historical result reads, one shared lifecycle/queue and current
approval/submission checks. Reject duplicate project/template IDs and unknown-project
planning. Do not construct authority by substituting another project's ID, add new
keys from browser data, duplicate coordinators or auto-provision a promoted project.
This block is not implemented yet. Exact operator approval/profile/runtime setup
remains gated even after multi-project source support.

## Multiple explicitly configured project templates

Implemented the source extension identified in the preceding checkpoint. The planner
captures a primary template plus at most 15 additional unique project/template bindings.
It selects the exact configured project after authorization, with no implicit cloning
or fallback. Startup captures the list before effects; result reconstruction owns its
copy. Existing coordinator, queue, assignment, keys and approval contracts are reused.
The protected planning view now reports missing project configuration accurately.
Historical saved receipts/results remain readable after template removal; removal is
not cancellation/revocation of existing work.

Initial two focused checks passed. The expanded expiry test initially tried to seed
a new task after restricted-role setup, producing SQL permission denial rather than
testing expiry. Moved that synthetic seed before role installation and used the
explicit coordinator pool for planner checks; no permissions were weakened. Four
focused checks then passed including selected-template precommit rollback and
additional-project revision/result reconstruction. TypeScript and full lint passed.
Independent source review found no authority/capture defect and suggested delaying
the configuration availability lookup until after authorization. Implemented that
ordering and a regression for inaccessible projects. Review of the revised source
found no new concrete issue.

The expanded `test:multi-project` suite, TypeScript, lint, fresh VPS build and 15
compiled planning/revision/startup/database checks all passed. Added a dedicated
compiled multi-project check afterward to exercise the new configuration through the
actual built bootstrap (not merely source planning behind a compiled HTTP handler).
Its combined run with result/coordinator lifecycle and package inventory regressions
passed 39/39, followed by TypeScript and full lint. The compiled case overlaps the
two project requests inside one restricted application, verifies captured template
bytes and no attempts, then confirms both owned pools close once.
No live effects or installation. See `MULTI_PROJECT_PLANNING_DELIVERY.md` for the
configuration contract, operator responsibilities and evidence limits.

### Resume checkpoint after multi-project integration

`c626687` is committed and pushed to the authorized private branch. No open PR
was present; no PR/merge/Actions dispatch or production effect occurred. Final
follow-up session 62504 exited zero (39 checks, TypeScript, lint); push session 8275
exited zero. Worktree has only the preserved unrelated private notes/image before
this local checkpoint. The fixed deadline remains 12:40:58 UTC; clock at this batch
was 08:22:01 UTC. The goal is not complete: live owner signing/custody, executable
fleet setup, production storage/restore/supervisor/login and real task acceptance
remain required. A read-only agent audit is checking actual connector entrypoint and
packaging gaps next, so subsequent work can target the critical path rather than
repeat completed source tests or polish unrelated screens.

## Explicit private one-task node launcher

The read-only packaging audit confirmed the old supervisor templates referenced
nonexistent `node-service.js`, while no executable composed the existing native
runtime and HTTPS connector. Added `scripts/run-private-node.mjs` and fixed compiled
`nodeConnector.js` export. Protected operator code supplies existing typed resources;
the command owns one explicit initial/recover attempt, drains runtime before releasing
journals, prints fixed summaries and never retries. No protocol, credential source,
listener, installer, runtime authority or automatic service was invented.

Independent review found an unbounded resource-close await. Corrected with bounded
cleanup observation, preserving resources if runtime drain remains uncertain. The
regression uses fake timers; documentation explicitly says underlying timed-out
cleanup may continue and acquisition cancellation is cooperative. Re-review found
no further concrete issue. Unix-only file permission validation is explicit;
Windows ACL handling remains required rather than weakening the gate.

Historical platform templates are marked non-installable and no longer demonstrate
automatic restart. Static diagnostics now return continuous_service_not_available
for valid-shaped inputs instead of incorrectly declaring owner-start readiness.
The package README distinguishes explicit task execution from continuous fleet use.

Seven launcher tests and four package checks first passed, followed by TypeScript
and full lint (session 72961 exit zero). Expanded sequential launcher, connector
dispatch/recovery/denial and synthetic TLS regressions passed; fresh VPS build,
the actual compiled composition denial test, TypeScript and full lint passed
(session 76187 exit zero). The compiled test is denied before credentials/network/
native execution and must not be reported as successful physical task delivery.
No downloads, live effects, production changes or native qualifications occurred.

### Resume checkpoint after explicit launcher

Committed and confirmed pushed as `a89a8d8` to the authorized private branch
(push session 83627 exit zero). The branch had no open PR; no Actions dispatch,
PR or merge. Unrelated private setup notes and image remain untouched/unstaged.
Clock at final branch check was approximately 08:36 UTC; original deadline remains
12:40:58 UTC. No test/push process from this batch remains active. A read-only
agent audit is mapping existing persistent journal, native transport and credential
adapters to the missing concrete operator composition. Continue on the actual
runtime/owner-signing critical path; do not mistake the protected factory contract
for a configured fleet or reset the overnight window.

## Standard persistent native configuration assembly

Added the standard assembly behind the compiled node entry, reusing existing
SQLite bridge/run/admission/execution/effect journals and current policy, profile,
recovery, signing, protocol authentication and HTTPS components. No new transport,
schema, credential backend or permission protocol. Operators provide five approved
pre-created private files; provisioned security/key custody and trusted pause/profile/
recovery/credential sources remain borrowed, not synthesized or automatically set up.

The path gate rejects aliases, hard links, symlinks, shared permissions and unsafe
existing sidecars before opening. It does not claim protection against same-UID edits
or safe ownership of all ancestors. Existing schema initialization writes local
journals; synchronous setup is not preemptible. Constructors for four reused stores
now close their database if initialization fails, allowing partial assembly cleanup.

The first persistence fixture omitted the sequence-one handshake and was correctly
rejected. Exposed the existing synthetic signed hello and recorded it before the
lease; the next run reached a wrong receipt-property assertion. Corrected that to
compare the exact accepted frame. No protocol/authority rule was weakened. Lint
also rejected a control-character regex; replaced it with explicit codepoint checks.
Three focused checks then passed with TypeScript/lint (session 3009 exit zero).
Added corrupt-last-store cleanup instrumentation: all five database closes occur,
no credential/key effect, and all four tests plus types passed (29939 exit zero).

Independent source review found no concrete authority/ownership defect and identified
the documentation caveats above. The fake-transport start uses actual assembled
policy/start controllers and private persistent files, then closes/reopens the state
and verifies exact receipt/run/effect-marker retention and denial of another start.
This is not actual Hermes execution or physical disk-loss recovery evidence.

Expanded sequential launcher/connector/TLS and persistence tests, existing admission/
execution/effect/bridge and current-policy/profile/recovery regressions, fresh VPS
build, compiled launcher denial and four compiled persistent-factory checks all
passed, followed by TypeScript and full lint (session 46095 exit zero). The compiled
factory suite requires the built export and has no source fallback. No test process
from this block remains running. No live or production effect occurred.

### Resume checkpoint after persistent node assembly

`dd5f7bb` committed and push confirmed (56889 exit zero); local HEAD equals the
authorized private remote branch. Only unrelated private notes/image were dirty
before this checkpoint. The previous turn is progress, not blocked. Clock at
verification: 08:48:33 UTC; original deadline remains 12:40:58 UTC.
No PR/merge/Actions/native call or production change. Source audit is now locating
the remaining local owner-signing composition among accepted E53-E58 components.
Do not mistake borrowed live sources or synthetic profile acceptance for actual
custody/consent, and do not qualify the continuous fleet from a one-task command.

## Owner-controlled review session composition

Joined existing canonical review and paired signature issuer behind an explicit
one-preparation/one-issue session. Trusted source and synchronous current-source fence
remain explicit; echoed review digest does not count as consent. Only human review
is exposed before issuance; full verified packet is returned once and intake remains
a separate authorized operation. No endpoint, credential/channel acquisition or real
owner action was introduced. Fixed `ownerReview.js` compiled entry is supplied.

Initial three tests passed. TypeScript initially narrowed phase across async closure
mutations incorrectly; a typed status reader resolved that without changing runtime
behavior. Added post-issuer-await source/consent fencing, wrong-target and signature-
handoff invalidation checks. Expanded source/intake/HTTP, five compiled scenarios,
types and lint passed (46479 exit zero).

Independent review identified a timer-only preparation deadline gap under blocking
code. Added monotonic checks before/after load and before publication plus a controlled-
clock overrun regression. Re-review found the gap resolved and no further concrete
issue. The stronger final compiled/source checks are recorded below after completion.
No key, SSH socket, credential store, owner attendance, provider or production effect.

Final fresh build passed all six compiled session scenarios, TypeScript and full
lint (47538 exit zero). A subsequent sequential source-session and existing compiled
approval/owner-review run passed 9/9 and diff whitespace checks (89291 exit zero).
This includes the existing browser-asset boundary check; no signing cryptography or
approval storage was introduced into browser assets. All named test processes ended.

### Resume checkpoint after owner review session

`35b1267` committed and push confirmed (80300 exit zero); local HEAD matches the
authorized private branch. No open PR, PR/merge/Actions dispatch or production effect.
Clock: 08:59:37 UTC; original deadline still 12:40:58 UTC. Only unrelated private
notes/image were dirty before this checkpoint. Previous turn is concrete progress.
Next missing integration is the actual owner-controlled presentation/confirmation
surface and trusted preparation/signing channel composition. The session/controller
does not provide those. An explicit private owner-attended command with injected
offline tests is a possible first surface; no live signing, credential lookup or
owner phrase may be performed by the unattended agent. Evaluate against existing
accepted components and avoid creating another transport/security protocol.

## Owner-attended terminal review surface

Added `scripts/review-private-owner-task.mjs`, an explicit protected-module/attached-
terminal command around the existing session. It displays exact escaped task text,
scope and dedicated canonical Ed25519 key fingerprint, plus approval and recovery
permissions/expiry. Exact interactive digest confirmation intersects a current-key
guard; no affirmative flag, environment consent, piped fallback, retry or dispatch.
Only the complete packet is delivered once to existing canonical intake. A separate
copy preserves the expected bytes while the intake callback runs, and receipt
validation reuses the strict application schema and exact task/attempt/operation/
packet bindings. Source/consent/custody and delivery authenticity remain required
trusted operator ports, not configured by this command.

Initial five command scenarios, TypeScript and lint passed (84993 exit zero).
Expanded source/session/intake/HTTP plus fresh compiled 11 scenarios, types and lint
passed (26115 exit zero). Independent source review found no blocking defect and
requested additional command-level cancellation, mutation and cleanup tests; added
those. Its cooperative acquisition/store timeout caveat is documented explicitly.

The first expanded cleanup-timeout test enabled fake timers after the command's real
five-minute timer was created. All eight assertions passed but a real timer kept the
process alive. Verified the exact test process and terminated only that local test
(78362); session 17927 exited one/SIGTERM and is not accepted as a passing run.
Moved fake-clock installation before both timer creations. No application behavior
or production process was changed to repair this test-fixture timer mismatch.

Corrected eight command scenarios, TypeScript and lint passed and exited normally
(93624 exit zero). The following observation was lost across compaction; its result
is not counted. At 09:16 UTC an exact process check found no matching active owner
review/build/check process, so a fresh sequential compiled verification was started.
Final independent source-only re-review found no remaining concrete blocker after
the added mutation, cancellation and cleanup tests. Cooperative cancellation and
the distinction between receipt validation and authenticated persistence remain
explicit limits, not qualified live behavior.

The renewed overnight prompt limits subsequent work to local commits: no pushes,
PRs, merges, Actions, installs, downloads or production effects. Preserve the
original 12:40:58 UTC deadline rather than silently extending this run.

Fresh compiled verification completed with exit zero (41671): all 14 owner-session/
command tests, 13 existing compiled approval and private launcher checks, TypeScript,
lint and whitespace validation passed. This establishes local release behavior with
synthetic signing and disposable storage, not owner attendance or a live task.

## Connector elapsed deadlines and continuous-pickup audit

Owner command saved locally as `68e8af3`; no push. Independent audit found that
continuous pickup is missing server-side dynamic canonical selection and matching
node task-runtime handoff, not just a restart policy. Lead inspected the exact
peer-task, managed-attempt and runtime queue bindings and saved the combined
acceptance plan in `CONTINUOUS_PICKUP_GAP.md`. No guard was removed to accept a
different task, and no new daemon/selection protocol was introduced.

Two new connector tests reproduced a genuine timer-only deadline gap: when the
event loop has not delivered the timeout callback, expired work could start or
continue polling. Both failed with missing expected rejection before the fix.
Monotonic boundary checks now supplement timer cancellation. Initial 15 source
connector checks, TypeScript and lint passed (64066 exit zero). Review found that
a slow false readiness result also needed an unconditional post-readiness check;
fixed and added no-wait/no-normal-disconnect regressions for one and three cycles.
Final verification is recorded below when complete. No physical transport or
provider execution was used; cancellation remains cooperative inside a running call.

Final re-review confirmed the false-readiness finding resolved with no further
concrete issue. All 17 final source connector checks, TypeScript, lint and diff
validation passed (35018 exit zero). Fresh node-launcher build and its compiled
launcher/persistent-resource checks passed (21620 exit zero). The preceding broader
node-launcher, TLS and packaging run also exited zero (31367), but the final source
and fresh compiled commands above establish the post-review state. Compiled launcher
denial is not a real successful network connection or native host qualification.

## Consecutive-task architecture trace

`1018748` is saved locally, no push. Inspected CR14A, security/authority and the full
CR5C contract, coordinator queue revalidation/never-staged recovery, managed input
receipt handling, HTTP peer attachment and node runtime setup. The existing recovery
hook is not a generic next-task selector. Added `CONSECUTIVE_TASK_DESIGN.md` to keep
the combined server/node goal intact: reuse existing queue/protocol, establish durable
allocation before dynamic attachment, retain per-task admission, reconcile before
fresh pickup, and do not substitute an operator callback or restart loop for that
work. The next concrete source question is existing durable capacity/reservation
ownership; this is local architect work, not a new owner-input blocker. No runtime
or production behavior is enabled by the design document.

Further inspected migration0014, the complete reservation-store implementation and
canonical ready-frontier reservation transactions. Resource head row locks exist,
but expired holds automatically stop counting against capacity. Existing canonical
usage is no-effect ready-frontier work; native planning has no reservation-store
call. The active-lease unique index is per job. This changes the next implementation
action: preserve a native occupancy/reconciliation binding across expiry rather
than treating the existing TTL ledger as proof an adapter is idle. Reusing the
existing locking machinery remains preferable to a second scheduler.

Deeper independent and lead callsite inspection found the actual native capacity
fence in coordinator.assign: tenant/project/node locks plus all active node leases,
not generic ResourceReservationStore. Existing NativeTaskCompletionService also
authenticates terminal/result bindings and releases capacity separately from quality
approval. Updated design to reuse these paths and avoid a second allocator. Reviewer
requested stable enrolled node/adapter capacity identity and explicit expiry-versus-
stop distinction; both added. This is source-backed architecture progress, not an
implemented dynamic fleet or new live evidence. No runtime code changed this batch.

## Exact owner-command packet through the task-result path

Native capacity/revision tests already cover occupancy release before quality review;
no duplicate implementation added there. Added a stronger joined owner-command test
instead: its actual paired signatures are stored, that exact packet/job is carried
through the existing managed HTTP fixture, signed dispatch, fake native execution,
saved exact result bytes and pending review. Asserted matching packet digest/job,
two signatures, one command intake, one canonical packet and one native start. Queueing
and dispatch remain explicit subsequent operations, not effects of owner confirmation.

The initial test selected a nonexistent queue `id` column and failed; corrected to
`SELECT 1`. The joined scenario passed (84672 exit zero). Independent review confirmed
same-packet continuity but found partial helper setup cleanup/ownership ambiguity.
Added catches around acquired node/HTTP helper resources and moved ownership transfer
to helper entry. A post-managed-setup injected failure now proves borrowed base/local
resources close once. Both focused scenarios, TypeScript and lint passed (68978).

The preceding full owner source suite, fresh compiled-owner tests and seven HTTP/
connector integration checks also passed with types/lint (78629 exit zero). That run
began before cleanup remediation; final post-remediation checks are recorded below.
No production runtime changed, real owner confirmation typed, credential accessed,
physical TLS connection opened or provider called.

Final post-remediation run passed all 16 compiled-owner session/command scenarios
and all seven downstream source HTTP/connector regressions, with diff validation
(64807 exit zero). Independent re-review confirmed cleanup ownership and no additional
concrete finding. No process remains running from these verification commands.

## Non-default native run identity and platform handoff refresh

Extended the exact owner-command journey to receive a different synthetic provider
run ID from start and assert that ID in the retained native journal. This exposed
the newly composed fixture's status wrapper returning the old default run ID. The
application correctly returned uncertain; the expectation failed (32114 exit one).
Fixed the fixture wrapper to preserve context.providerRunId, matching the already
existing managed-session fixture. No production run-ID checks were weakened.

Focused corrected journey/types/lint passed (21160). Final compiled-owner command
suite (10 scenarios), seven source native-runtime/connector integration checks,
TypeScript, lint and diff validation passed (89593 exit zero). All native responses
remain synthetic and no network/provider operation occurred.

Updated existing fleet-setup pages instead of creating another parallel installer
guide: link current VPS/one-task/owner-command artifacts, identify the actual Windows
ACL gap, prohibit automatic restart of one-task commands, separate historical PR
snapshots from current remote evidence, and explicitly preserve local-only transfer.
Johnny5's assigned VPS preparation is not restarted by this guide. No clone/fetch,
download, credential or host operation was performed. All 27 local documentation
links resolved. Independent source-only review found no concrete defect in the
run-ID test or refreshed handoffs.

## Canonical queue routing and actual HTTP receipt lifecycle

Canonical lookup now emits an immutable routing projection only after existing
approval/intent checks. Managed delivery refuses mismatches before stage/transmit.
Independent review requested direct projection-fault coverage; all four task fields
are now injected after actual lookup, asserting zero callbacks and unchanged state.
The valid path dispatches once. Initial final routing tests passed 28 cases, types,
lint and VPS build (52739 exit zero); no external operations occurred.

Following the real queue-to-HTTP path exposed a functional integration defect rather
than another component gap: queued delivery bypassed ManagedNativeInput state, so
the signed receipt failed at HTTP step (6472 exit one, native_http_node_unavailable).
Added internal FIFO composition with exact task/mode/state checks and canonical
stage/transmit revalidation. The same regression now saves exact completed bytes
into pending owner review with one fake start (64101 exit zero, including types).
No owner command is substituted for the queue delivery in that journey.

Expanded seven-file source test run passed 95 cases, types, lint and a fresh VPS
build (38236 exit zero). Final added cancellation and generation-replacement checks
passed in 38 input/HTTP cases (1413 exit zero): cancellation aborts receipt suffix;
replacement after staging causes zero transmissions and no action on the new
generation. Binding mutation, wrong task, recovery, unready, prior manual staging,
duplicate dispatch and uncertainty are also covered. Independent source review
found no concrete defect and requested these negative paths. All transports/native
responses are injected; PGlite/SQLite are disposable. Production and continuous
pickup remain unqualified and no credentials or GitHub access were used.

Final compiled startup/session checks passed 13 cases plus types/lint/diff (2187
exit zero). These compiled checks exercise startup and isolation, not a compiled
end-to-end queue journey. The actual source connector journey now runs both owner
dispatch and canonical queue dispatch: no test-side runtime.start call is needed,
one simulated capabilities/start/status sequence delivers exact bytes for pending
review, and the connector closes once. All four connector scenarios, types, lint
and diff checks passed (64841 exit zero). The test invokes the canonical queue
handler at an injected wait boundary; it does not claim a running pg-boss daemon,
multiple successive tasks or real PostgreSQL concurrency.

## Explicit server queue-selected session binding

Added opt-in `assignment: "queue"` peer configuration. After node authentication,
only canonical queue delivery can bind the initially empty managed generation to
one exact task; input is copied/frozen and cannot switch in place. Manual stage/
transmit cannot choose a task in this mode. HTTP requests still carry no task or
queue selector. Unsupported recovery open is refused before replacing an existing
generation. Fixed-task and explicit fixed-task recovery remain supported.

The connector's canonical queue journey now uses this server mode, not a fixed
peer task. Its node runtime still has a fixed queue ID, so this is not consecutive
execution. Independent review found no within-generation defect but correctly
identified the missing durable prior-work predicate across initial connections.
Recorded that deployment limitation and left service/operator examples unchanged.

Initial types failed on a denial-test helper assuming every configuration has a
task (29958 and 59664 exit two; 39 runtime cases passed in the latter). Updated the
helper to narrow the union and added body-selector/implicit-recovery refusal checks.
Corrected types plus 39 queue/HTTP cases passed (75446 exit zero). Final five-suite
input/queue/HTTP/connector verification, types, lint and VPS build passed (98715 exit
zero). Separate exact connector check confirms a completed result still retains
the local executing effect claim (39849 exit zero): no capacity settlement is
implied by result delivery. No production/network/provider/key operations occurred.

Independent fixture audit found no existing combined two-independent-task fixture
with shared canonical and local stores. It identified reusable ordinary proposal/
assignment and capacity-release helpers, while warning not to use fresh per-task
journals or increased capacity as turnover evidence. Local native claim settlement
is the next substantive lifecycle gap; no claim has been deleted or discounted.

Independent profile audit found no existing task-specific Hermes cleanup proof in
the accepted profile interface. Runtime close drains local owners/transports, not
the upstream process tree. Reusable terminal effect/execution methods validate
event/history, not the truth of an asserted receipt. Recorded this exact gap and
the need for a trusted per-task evidence producer/verifier; Codex-specific
descendant-aware cancellation cannot be substituted as Hermes proof.

Fresh compiled session/startup checks passed all 13 cases plus final types/lint/diff
(22661 exit zero). Clock 10:05:48 UTC, original deadline still 12:40:58 UTC. No
verification process from this batch remains active. Local-only implementation is
accepted as a partial server-side integration, not an operational fleet release.

## Task-bound cleanup evidence consumer

Implemented the missing read-only native cleanup consumer using existing pinned
owner trust, artifact signatures, native run journal and effect store. Separate
domain-separated owner acceptance binds exact enrollment, qualified producer and
explicit per-run cleanup guarantees; the old profile acceptance is not upgraded.
The protected producer snapshot must match exact run/binding/snapshot/marker with
zero descendants/pending native requests and a freshness window at most 30 seconds.
No producer, signature workflow, settlement, runtime wiring or capacity release was
created. Tests keep real local run/claim records and synthetic accepted supervisor
evidence, and assert accepted proof leaves both records and active capacity unchanged.

Initial tests passed but types found narrowing errors from an arrow never-returning
helper (96583 and 81103 exit two). Changed it to a declared never-returning function;
types/lint passed (56279). Independent review found a genuine post-read expiry gap:
the final synchronous evidence read could cross the earlier wall/monotonic checks.
Added post-read wall-clock/cancel checks and a post-current monotonic check, with
clock-advancing/cancelling source regressions (12236 exit zero, four tests/types/lint).
Any failed verification/freshness check permanently closes that consumer instance;
it cannot revive older proof. Durable restart revision guarantees remain the separately
accepted producer's responsibility, not an in-memory verifier claim.

Final five cleanup tests plus existing native profile tests passed 20 cases (47357),
including altered identity/marker, forged acceptance, retained native observation
changes, committed trust changes, source revision, pin close, cancellation and late
reads. Independent re-review confirms the timing repair and no further concrete
finding. No production evidence has been manufactured and no claim was freed.

## Guarded durable effect settlement groundwork

Original deadline remains 2026-09-08 12:40:58 UTC; the subsequently requested new
goal prompt did not reset this existing overnight run. Prior prompt-only turn made
no implementation progress; resumed with the next safe local persistence action.

Added `SqliteEffectClaimStore.applyChecked` using the existing write transaction,
exact-current snapshot digest, captured event and synchronous pre/post-write checks.
Any failure rolls back the event and capacity change, including after the tentative
write. Duplicate replay is checked too. This is a trusted local persistence seam,
not a replacement for cleanup verification or an enabled consecutive worker.

Initial test command failed on an incorrect directory import (319d0b exit one),
corrected to security/index.ts. Next two test runs (37833 and 89568 exit one) exposed
a test-fixture locking mistake: countActive intentionally opens a write transaction,
so it cannot be used on a second connection during the guarded writer callback.
Changed that in-transaction observer to load the committed snapshot; capacity is
still checked after rollback and commit. No store locking safeguard was changed.

Independent review found unobserved rejected Promise results from accidentally async
guards. Captured and observed native Promise rejection before synchronous refusal;
added immediate/late rejection and async-throw tests that yield an event-loop tick.
Independent source re-review found the issue resolved and no new concrete defect.
All 12 effect-store tests, TypeScript, focused lint and diff check passed (22214 exit
zero). Tests prove rollback and committed visibility, stale/replay guards, event
capture and refusal of asynchronous acceptance. No real native task or production
capacity was changed. Next: bind this seam to fixed cleanup-derived confirmation and
execution-state settlement before attempting the two-task integrated journey.

## Joined local native task settlement

Added `createNativeTaskSettlement` and the runtime's exact-binding
`closeForSettlement`. The latter drains the actual existing task runtime and
explicitly does not attest to physical descendants. The cleanup consumer now
computes one fixed confirmation event and supports freshness checks across only
that exact claim transition; arbitrary target digests/altered events are refused.
Settlement closes/drains the runtime, verifies separately accepted synthetic cleanup
proof, matches execution identity/admission/authority/deadline, records the retained
native completion event, then confirms the effect with transactional freshness.
The execution-only crash window retains capacity and reconstructs through exact
execution event replay without another native call.

The combined runtime test now routes saved result bytes into pending review through
actual managed/native code, closes that runtime, and settles its existing local
stores. Canonical records remain unchanged and the closed runtime cannot start.
Synthetic cleanup signing/proof generation was extracted into a shared test helper;
the ordinary and revised managed fixtures expose their already-existing local
execution/effect stores. No producer, owner signer, production wiring or server
capacity release was introduced. Historical receipt recovery after the effect commit
still refuses; dynamic next-task runtime selection and the two-task journey remain.

Initial five consumer tests/types passed (75206). Eight settlement tests passed but
types found void/undefined fixture assertion mismatch (17008 exit two), corrected by
typing the real runtime assertion void. Next 12 combined cases passed but fixture
Local types omitted existing effect/execution members (43669 exit two), corrected
without inventing stores. Independent review found ignored async drainage assertion
results; the bound assertion now requires synchronous undefined and observes rejected
Promises. Immediate and post-effect-write failures are tested, with rollback retaining
capacity. Independent re-review accepted this and later identity/digest-check changes.

Broader test run first hit the intended exact-facade allowlist (41765: 28 passes,
one failure), which was updated to include only the new drainage method and reject
unknown task settlement. All 30 cases then passed (32085), but TypeScript found the
empty-array assertion narrowed later call strings to never; replaced it with a
length assertion. Final types, focused lint and diff check passed (60229 exit zero).
Fresh VPS compilation and four compiled managed-session/node-launcher checks passed
(39896 exit zero). Existing build warnings were not repaired or downloaded around.
The new settlement coordinator is source-tested, not enabled in the launcher.
No test handle remains active. Original fixed deadline is still 12:40:58 UTC.

## Historical local settlement recovery

Implemented read-only recognition of already committed local settlement using the
existing protected effect, execution and native journals. No new table, cleanup
producer, signer or current authority is introduced. The effect-store confirmation
lookup validates its full history under the existing transaction and now checks
event-ID/timestamp index mirrors against event JSON. The history reader matches the
exact retained native snapshot and completion events, identity, admission, authority
and deadline, with cancellation/deadline checks on both sides of repeated reads.
The result explicitly says historical completion, not current cleanup or new capacity
release. Matching cross-store reads are not a shared SQLite transaction.

Real-file effect tests close/reopen SQLite and reject altered lookup mirrors. The
joined local settlement/runtime paths recognize their receipt after owner pins close
and cleanup proof expires, without new native calls. Cancelled/late/corrupt/foreign
or execution-only evidence is refused. Initial 13 store tests/types passed (75930),
then 14 combined cleanup/runtime tests/types/lint (24381). Final 27 source cases,
types, focused lint and diff check passed (16244 exit zero). Independent source
review found no blocker and confirmed the protected-journal/non-atomic-read limits.
No verification process remains active. Clock 10:45:35 UTC; original deadline unchanged.

### Concrete next two-task fixture path

Independent read-only source audit found direct reuse rather than a second queue or
allocator. Use TaskQualityCoordinator.reconcile with the existing ownerConfig and
scenarios:[] on NativeResultSubmissionService.inspectSubmitted's actual A result;
it returns waiting_review plus canonical capacity release without owner quality
approval. Then propose/plan/assign/prepare/sign/save/enqueue independent B in the same
canonical database. Reuse the existing managed manager/roles and one outer owner for
the bridge/native/admission/execution/effect journals; do not call the whole managed
fixture again (it recreates roles). Supply B-specific policy/readers/runtime binding
over shared stores and its own exact fake native run/session response.

Keep canonical route limit two (one unrelated seeded active lease plus A) and native
effect limit one. Before canonical A release, B assignment must fail. Before local
A settlement, B native admission must remain blocked without inventing an effect or
destroying its safe pre-effect retry path. After both releases, B must run once with
A's result/review/history intact. The helper currently captures one task/config and
needs bounded per-task composition, not relaxed guards or new journals.

## Two independent tasks on shared stores

Added a joined A/B test using one canonical DB, managed manager, bridge journal and
native/admission/execution/effect stores. The fixture can create a per-task runtime
with supplied task config/dependencies while retaining one outer resource owner, and
can connect an explicitly unbound initial server queue generation. Fixed-task helpers
remain unchanged by default; queue mode cannot silently turn recovery into initial.

The existing quality coordinator releases canonical capacity with waiting_review;
cleanup settlement separately closes each runtime and frees its local effect. B
assignment fails while seeded lease+A fill route limit two. B pre-effect policy
check fails while A consumes native ceiling one, without reserving a B run or claim.
After A settlement, B starts exactly once with the same stores. Both pending reviews,
distinct result bytes/hashes/attempts, A's history, and the unrelated seeded lease are
retained. Late A input and closed-A start are refused without affecting B. No raised
capacity, fresh journals, deleted leases or owner quality approval was used.

Initial run 40050 failed because B's synthetic lease used nonexistent assignedAt;
type check 72897 confirmed the field error. Corrected it to the actual acquiredAt
receipt field. The two-task test/types/lint then passed (88939). Stronger byte/generation
isolation assertions plus existing runtime/connector suites passed all 22 cases,
types, focused lint and diff check (3537 exit zero). Independent source review and
incremental review reported no concrete finding, with the scope limits preserved.

This remains a manually driven injected integration, not a deployed continuous
worker: the test supplies B's config/policy, drives queue delivery/transport pumping,
reconciles quality and supplies synthetic accepted cleanup evidence. Automatic
node-side discovery and lifecycle sequencing remain real build work. No test handle
remains active; original fixed deadline remains 12:40:58 UTC.

### Next implementation trace

The current node runtime still requires configuration-time queueId. Its receive()
checks the exact queue before delegating to the bridge; reporter is created eagerly
with that queue. A future explicit unassigned factory can reuse this implementation,
but must bind once only after the signed dispatch is accepted into the existing
journal, serialize/recheck queue identity inside the wire FIFO, and lazily create
the per-task reporter from captured dependencies. Merely taking an unsigned hint or
changing the guard to accept any queue is not equivalent. Keep the existing fixed
configuration validator unchanged: private-native-configuration.ts calls it, so
expanding that validator would accidentally enable an unaccepted launcher mode.
The current queueId facade is not consumed elsewhere in src except configuration;
any new preassignment metadata semantics must remain explicit and tested. This is
an implementation trace, not accepted code or permission to enable a service.

### Initial unassigned runtime implemented

The separate `createUnassignedNativeNodeRuntime` now implements the preceding trace.
Fixed-task validator/launcher remain unchanged. Queue binding follows exact signed
dispatch admission and retained recorded receipt; queued receive rechecks prevent
switching after binding. Reporter construction is lazy from captured dependencies.
Before binding, metadata refuses a queue ID and accepted-dispatch readiness is false.
The two-independent-task integration now supplies no queue ID to either runtime,
while retaining exact task policies and manual lifecycle/transport orchestration.

Recovered test handle 17630 was missing, so results were not assumed. Fresh test
47993 found the competing-dispatch fixture used an invalid queue ID. The broader
37799 run passed 40 cases but failed the corrected fixture's stale approval-body
digest before signing. Recomputed the digest using the existing canonical helper;
56908 then passed all three new tests, TypeScript, focused lint and diff check.
Neither failure was an application assertion; neither was converted to a pass.
Independent source review reported no concrete defect, explicitly leaving outstanding
work reconciliation, per-task policy resolution and continuous lifecycle ownership
unproven. All evidence is local/synthetic; no native provider, launcher, production
service, GitHub or credential operation occurred.

Next source trace: reuse `createNativeCurrentPolicy`, not a permissive callback.
It already reads verified ceiling, node control/pause, key availability, node-wide
active effects and exact accepted lease evidence with freshness fencing. However,
its constructor needs the approved request, lease message ID and parent authorities.
`createNativeLeaseEvidence` requires a retained signed `job.lease.grant` plus the
matching current bridge attempt. The native runtime's receive allowlist currently
excludes lease grants. Merely deriving a request from native dispatch cannot replace
that missing lease provenance. Trace the existing lease delivery/acceptance path and
compose it before claiming task-independent operational policy resolution. Do not
broaden the wire allowlist or fabricate an accepted lease to make the test work.

Final fresh combined runtime/connector/consecutive/unassigned run 20894 passed all
41 cases. VPS compilation 95826 passed; compiled managed-session and fixed node
launcher checks 22954 passed all four cases. Existing bundler/deprecation warnings
remain; no production startup was attempted. Original deadline stays 12:40:58 UTC.

### Lease-path audit after 52e03b7

Previous goal turn made concrete progress (runtime implementation, 41 source and
four compiled checks, local commit). This turn traced the missing production policy
path through actual source. ServerNodeSession cannot sign/send a lease grant in its
current native session state machine. Native runtime rejects that message type;
PortableNodeBridge's generic grant branch only records a command. No source caller
of journal.upsertAttempt supplies the missing native grant transition. The lease
fixture does so manually. Existing current-policy tests verify its reader/controller
in isolation, not native session delivery. This rules out treating a dynamic policy
callback or receive-allowlist expansion as a completed integration.

CONSECUTIVE_TASK_DESIGN now records the joined grant staging, same-generation delivery,
atomic acceptance, existing verified policy composition and failure/reconnect tests
required next. No new broker, lease format or relaxed authority is proposed. Production
effects remain unauthorized, and no additional provider or GitHub action occurred.

### Atomic initial lease storage

Implemented recordInitialLease on the existing bridge journal, with no migration or
new wire format. Already-consumed authenticated inbox evidence is required. Initial
command/attempt writes share one transaction, exact active replay preserves progress,
partial/conflicting/terminal state refuses, and synchronous exact-true fences run
before/after writes with post-fence receipt/attempt checks. Failed commit leaves the
consumed inbox but no partial command/attempt. It neither authenticates a sender nor
grants native execution; the source method documents its trusted-intake prerequisite.
Lease fixture now exercises this primitive; it still supplies synthetic consumption
and freshness, not a complete server/native grant delivery path.

Initial targeted run 32124 passed 38 cases with types/lint. Additional independent
SQLite connection/reopen evidence passed 30173 (11 cases/types/lint). Source review
found malformed retained checkpoint/sequence fields could survive duplicate checks.
Reused the existing reconciliation attempt schema (export only; wire shape unchanged)
and added object/nonstring/oversize checkpoint plus fractional-sequence regressions.
Final combined initial-grant/lease/current-policy/bridge run 28344 passed all 61 cases,
TypeScript, focused lint and diff check. Independent source re-review found the issue
resolved and no further concrete persistence defect. No production/GitHub/provider
operation occurred. Source-only storage acceptance does not complete automatic pickup.
The unchanged protocol wire/schema regression suite also passed all 13 cases (2631).

### Exact task/channel lease intake

Added createNativeLeaseIntake around the existing atomic journal method and retained
lease reader. It captures task/channel/server pins and dependency methods, rechecks
actual server signing trust, exact grant/task/authority identity, frame/lease expiry,
five-second monotonic deadline and synchronous task freshness before persistence.
It requires a real AbortSignal and authenticated replay inbox. Native execution,
renewal, producer signing and runtime wiring remain outside this component.

First type run 14549 and initial tests/types run 74569 failed on a declaration that
incorrectly placed currentServerTrustRevision on ServerTrustStore (15 tests passed).
Corrected the type to the actual persistent-security repository interface. Combined
61181 then passed 58 cases, TypeScript and lint. Independent source review found
missing runtime signal validation and clock sampling before a potentially slow
final trust callback. Both were corrected; added invalid-signal and final post-write
trust-read expiry/rollback tests. Existing timeout/overlap tests prove late resolution
cannot create a command or attempt after closure. No actual provider, credential,
GitHub or production operation occurred.

### Lease bridge integration

Added createNativeLeaseCommandHandler to connect the checked intake to the existing
authenticated PortableNodeBridge command path. It captures the exact task/server
configuration, binds a negotiated connection, composes channel/task freshness and
owns intake closure. Non-grant commands retain the existing bridge fallback. New
joined tests use real bridge authentication/replay, atomic lease storage and the
existing verified lease reader, without fixture-written commands/attempts.

Initial test 26644 failed because fixture server/bridge connection IDs differed;
fixed the deterministic node ID factory and registered resource cleanup before
handshake setup. 68017 passed two tests but found missing method parameter types;
fixed those. 75818 passed all 43 combined bridge/intake cases and TypeScript but
lint rejected a forward-declared let; changed to a const captured by a deferred
callback. Input parsing now occurs before channel callbacks, inside failure closure.
Independent source review found no concrete blocking defect and retained the scope
limits: no canonical server lease producer, runtime wiring or native permission.
Final corrected run 63408 passed both joined tests, TypeScript, focused lint and
diff check. No live provider, credential, deployment or GitHub operation occurred.
Post-remediation run 36271 passed all 20 intake cases, TypeScript, focused lint and
diff check. Independent source re-review confirmed both findings resolved and found
no further concrete issue. Grant production/delivery and runtime policy wiring are
still unfinished; original overnight deadline remains 12:40:58 UTC.
