# Idea Lab and ABS workflow delivery

Owner priority, 2026-09-07: complete multi-bot Idea Lab and ABS news-to-research.
This supersedes the immediately previous research-first sequence, not security rules.
Branch: `codex/idea-abs-workflows`. Public release remains a separate reviewed snapshot.

## Implemented in this batch

- Idea Lab coordinator now sends each participant excerpts from the complete previous
  round instead of repeating an isolated first-pass prompt. First-round opinions stay
  independent. Full opinions remain in the existing registry. Excerpts are evenly
  budgeted and explicitly untrusted; no tool or execution authority changes.
- Multi-round prompt capacity is checked before admission, ledger preparation or any
  provider call. The existing 800-character filtered transport limit is not widened.
- Authenticated `POST /api/v1/projects/:projectId/tasks/from-abs` converts a validated,
  project-matched ABS proposal into an ordinary saved task through WebTaskService.
  Source URLs, digests, goal, requested capability/platform and original title are
  retained in the task. Provenance hashes are not independent verification of news.
- Browser client shares the original task-save idempotency and uncertainty handling,
  retaining the ABS endpoint on explicit retry. No parallel queue or SQLite authority
  was added. New tasks remain proposed and do not contact agents or publish content.
- Shared browser/server size preflight preserves full titles in instructions while
  abbreviating long headings. Combined provenance above the existing 4,000-character
  task format is explicitly unsupported; no sources are silently omitted.

## Evidence and scope

### Between-turn live authority and time checks

Inspection before live start composition found that the coordinator validated admission
only at panel entry. It now revalidates the exact admission and selected participant's
evidence before each new marker. Existing same-admission/same-run `consume` replay
checks current sealed/native decisions before returning inertly; it does not mint another
owner window. Expiry, revocation or verification failure records a definite pre-next-call
failure, preserving already settled contributions and truthful provider-contact history.

Post-await time checks prevent expiry during verification from authorizing another turn.
Independent review identified a missing elapsed-session-budget check after those waits;
the common deadline check now runs immediately before the marker. A regression crosses
the session deadline while admission stays valid and proves zero calls/markers. Twenty-five
admission/coordinator tests pass, and the preceding authority-store-inclusive run passed
37 checks before this final deadline regression was added. TypeScript passes. Re-review
found no concrete residual defect. These are synthetic seams and PGlite tests, not live
provider acceptance. Authorization is checked at admission points, not continuously;
revocation after a successful check cannot retroactively cancel an already-started call.
No new web start operation or native qualification was enabled by this correction.

### Owner decision form and exact-request recovery

The private Idea page now offers Create a project, Save for later or Reject for an
eligible retained synthesis. Project creation uses editable title/summary and a stable
session-derived project ID; the receipt links to the existing project workspace. Server
capability flags distinguish decision access from project creation access, without
granting authority in the browser. The intent schema is shared from browser-safe domain
schemas, not imported from a server service into the client bundle.

The browser client retains exact session/synthesis/intent after uncertain responses,
refuses changed choices, validates receipt scope/outcome/project, and does not auto-retry.
Editing and parent refresh are disabled while held; the existing navigation warning is
reused. Forced closing or overriding a leave warning does not preserve the in-memory
request, but committed decisions remain readable. Tests exercise injected HTTP response
loss, explicit recovery, mismatch/later denial, eligibility fields and static form labels.
Eighteen focused page/decision/history tests pass, plus TypeScript, focused lint and VPS
compilation. Independent source review found no concrete defect; no mounted-browser
interaction or live-panel acceptance is claimed. The Sites skill influenced native form
accessibility and reuse of the established layout, not authentication, storage or hosting.

### Managed owner decision resource and SQL permissions

The existing optional Idea pool now owns the decision operation through the same
managed admission, input capture, guarded transactions and cleanup as saves/stops.
No extra pool or service was introduced. The fixed role/preflight adds reads and inserts
for existing policy/permit/decision/project/lifecycle tables. It cannot update those
records, create opinions/syntheses or dispatch jobs. This is application-constrained
authority: SQL INSERT permissions themselves do not encode the owner decision rules.

Policy rows have append-only UPDATE/DELETE/TRUNCATE triggers (migration 0005). Removing
redundant row locking on those immutable reads avoids needing UPDATE privileges;
SecurityStore retains its identity lock, and the private bridge retains its workspace
lock and atomic shared-session transaction. Thirty focused role/startup/lifecycle/security
checks pass, including promotion and exact replay under the actual restricted login.
The startup route test additionally rejects a draft without synthesis as ineligible,
not unconfigured. Independent source review found no introduced concrete defect.
Evidence is serialized PGlite with the existing TEMP metadata exception, not independent
PostgreSQL concurrency or production-role setup. Owner browser controls remain open.

### Shared-session owner decisions and project handoff

`WebIdeaDecisionOperation` bridges verified private sessions to the existing
`IdeaLabOwnerDecisionServiceV1`; it does not duplicate project creation or omit the
stored owner permit. One outer transaction contains policy, permit, project, lifecycle,
decision and audit writes, including the shared session's precommit expiry/revocation
checks. The stable workspace lock serializes competing decisions. Exact replay retains
the original decision time and owner identity, without creating another project or job.
An existing unfinished run blocks decisions; legacy retained synthesis without a run
is not relabeled as live evidence. Promotion additionally requires `projects.create`.

The optional POST `/api/v1/ideas/:id/decision` route accepts bounded JSON with exact
session/synthesis digests and the existing owner intent schema. It is unavailable unless
trusted composition supplies the operation. Managed startup currently does not; the
SQL role/profile and browser controls remain unfinished. The intended next composition
reuses the existing Idea resource, with its additional permissions explicitly verified.
No production grants were changed and no new credential/pool was opened.

Fourteen decision/API tests pass, covering save/reject, promotion followed by ordinary
task proposal, lost-response-style replay after time advances, current owner access,
logout, mismatched synthesis, unfinished run, project collision, and atomic rollback on
audit failure. TypeScript, focused lint and VPS compilation pass. A new task assertion
initially used the wrong receipt property; the corrected regression is the accepted
result. Independent source review found no concrete introduced defect. Tests use one
serialized PGlite instance and injected HTTP, not independent PostgreSQL transactions,
browser interactions, a restricted decision login or real agents.

### Protected owner stop command

The separately configured Idea operation now exposes POST `/api/v1/ideas/:id/stop`
and an owner-only detail-page control. It checks exact session/run identity, current
read/cancel permissions and shared-session revocation in the same transaction as the
stop request and audit. Explicit repeat requests are intrinsically idempotent. A turn
already marked for provider work remains pending rather than falsely confirmed stopped.
The existing managed lifecycle owns the operation; no new pool, driver or auto-retry.

The fixed Idea role/preflight adds run-event SELECT/INSERT. These are general event
insert privileges; application code restricts this route to stop transitions. An actual
restricted-login test found event-row FOR UPDATE incorrectly required update rights.
The redundant lock was removed, retaining the stable workspace lock and fresh event
read. The initial failed test/full-suite run is not accepted evidence. The corrected
60-test workflow suite and 14 overlapping stop/role/ledger checks pass; full TypeScript
and focused lint pass. Independent source review/re-review found no residual concrete
defect. Tests include lost HTTP responses, conflicting targets, logout and restricted-role
in-flight stop/replay. PGlite is serialized; no real PostgreSQL concurrency or physical
provider cancellation is claimed. Static markup is not mounted browser interaction.
VPS compilation and 12 compiled handler/startup checks also pass. The initial direct
Node test invocation omitted the required `--import tsx` loader and failed before tests;
the corrected invocation is the accepted result. No installation or deployment occurred.

### Owner creation form and exact-save recovery

`758f00e` connects the New idea form to the supplied creation operation. The catalog's
`canCreate` flag requires configured storage/operation and current owner create/read
permissions; the server still rechecks every command. Input includes the business
brief, intended customer, rounds, time and cost limits. Saving is labeled non-executing.
The endpoint echoes the request key in its receipt. The bounded browser client holds
the exact body/key after uncertain saves and subsequent denials, rejecting a switched
request or mismatched receipt. Refresh/Cancel cannot unmount an active save, and the
existing navigation guard is reused. No browser persistence or forced-close recovery.
The Sites skill informed existing-layout/form-state reuse, not a hosting migration.
The private VPS/PostgreSQL architecture and local-only deployment boundary are unchanged.
Independent source review found no concrete defect. Tests cover real disposable HTTP
save/response-loss/replay, later denial, mismatched receipts and static labels; no mounted
browser lifecycle/visual QA or live participants are claimed. Production creation still
requires the separate coordinator role and composition, not a web-role permission expansion.
All 46 focused workflow tests pass, alongside 16 overlapping compiled/startup/Idea
integration checks, full TypeScript, focused lint and VPS compilation. These counts
are different scopes, not an additive unique-test total or production acceptance.

### Non-executing owner session creation

`f0f8e49` adds `IdeaSessionCreationService` and an optional scoped `ideaCreation`
operation on POST `/api/v1/ideas`. Creation validates the full owner brief/round limits,
requires current workspace-wide owner create/read grants, and writes the immutable
session and audit record in one transaction. It does not instantiate any driver or
start a panel. Configured participants remain draft descriptors under the existing
session contract, not qualified live agents. There is no new database engine or queue.
The web SQL role stays read-only for Idea records. A separate coordinator role and
production composition still need implementing; the standard web bootstrap explicitly
rejects silently injecting this operation. Missing configuration returns unavailable.
The create form is not yet connected, and deployment remains unconfigured.

Independent review found that replay used the current roster. `bd76e1a` recovers the
original retained roster/time and compares owner input without substituting current
configuration. Tests cover audited save, reopen/replay including roster changes,
changed input conflicts, rejected oversized/scope-spoofed/non-owner requests, HTTP
save/read/replay, foreign origin and logout denial. Forty-three focused workflow tests
passed before the replay correction, then seven creation/compiled-app checks passed
with the correction. Full TypeScript and focused lint pass; VPS compilation passed.
No real concurrent PostgreSQL, production-role or live-provider acceptance is inferred.
Independent source re-review of the replay correction found no new concrete defect.

### Private Idea Lab pages

`beeaf72` mounts protected `/ideas` and `/ideas/:sessionId`, adds the private navigation
entry, bounded browser response validation and saved discussion rendering by round and
participant. Owner decisions link to the existing separate project workspace. Loading,
unavailable, empty and missing-contribution states contain no generated fallback records.
The Sites skill informed reuse of the existing private layout and explicit states; the
owner's local/VPS architecture overrides default Sites hosting. No preview/listener/deploy.
Independent review found that synthetic confidence had been labeled bot-reported.
`320575f` retains source provenance, checks its consistency, labels test contributions
and warns that their synthesis is not live panel evidence. Provider-history rendering
has a separate fixture assertion, not a claim that real providers were qualified.
The compiled route test's historical `/ideas`-is-404 expectation was replaced with a
protected page assertion plus logout denial; fixture/local-pilot APIs remain inaccessible.
Forty focused workflow tests passed before the label correction; focused tests cover
the final correction. No real browser interaction or live provider result is inferred.
Final TypeScript and focused lint pass. The VPS artifact rebuilt and six final
compiled-app/browser-client checks passed. Independent source re-review found no new
concrete runtime defect; the test-only literal-type correction was separately inspected.

### Retained Idea Lab discussion access

`0599aea` adds protected GET `/api/v1/ideas` and `/api/v1/ideas/:sessionId`.
These use owner-only workspace-wide session read/list grants, shared session revocation,
and the existing keyed registry. Detail returns retained contributions, synthesis and
owner decision; it does not infer a live run state from their presence. Missing keys are
explicitly unavailable, with no fixture fallback. Exact selected session identity and
workspace are checked; cursor pagination retains every session instead of truncating at 25.
The private SQL role template adds SELECT only on sessions/contributions/syntheses/decisions.
No SQL grants were applied outside disposable tests. Page mounting is now implemented
above; commands remain open.
Four added tests cover retained records/reopening, owner/operator rejection and wrong scope/key,
52-session pagination, protected HTTP routes, and denied Idea table writes. TypeScript,
focused lint, VPS compilation and 41 combined workflow/compiled-app tests pass locally.
Independent review found a possible READ COMMITTED mixed snapshot. `e04fb08` validates
the exact returned contribution/synthesis/decision tuple with existing parsers and rejects
an incoherent response. The new interleaved-visibility regression and all four Idea read
tests pass; this is injected statement visibility, not real PostgreSQL concurrency evidence.
Independent source re-review found no residual concrete defect in the correction.

### Protected saved-news workflow and full idea brief

`b98991a` and `91a82fe` add a private project News page, authenticated GET list and
read-only POST preparation. Research/setup-guide preparation reads an exact HMAC-checked
retained story, rejects unreviewable sources and inactive projects, and returns a draft
without storing a proposal or dispatching anything. The user inspects this draft and saves
it through the ordinary task command; all source links/digests are retained in instructions.
The preview proposal identifier is a draft reference, not a separately stored proposal.
The web role gains SELECT only on `control_abs_story_versions`; ingestion and proposal
storage remain inaccessible. Configuration accepts a supplied news integrity key but
does not create one, collect sources, apply grants or activate a service.

Independent source review found the 1,500/1,200 goal mismatch and navigation that could
lose an uncertain save key. Both were fixed and re-reviewed without new concrete findings.
Departure guarding preserves the active form, but is not persistence across forced closure
or a user overriding the browser warning. Five news tests cover service/HTTP source-bound
preparation and save/replay, revoked access, restricted role rights, SSR rendering and
simulated navigation guards. Real browser interaction and production PostgreSQL remain untested.

`69817c3` preserves title, full idea summary and target customer in the operator's prompt,
instead of passing only the title. Capacity is checked before a new session is registered
and again for older sessions before starting. The 800-character transport bound is unchanged;
long briefs fail explicitly rather than losing owner context. A two-round fake-driver test
proves all three fields reach all eight turns and oversized input creates no session/call.
`pnpm test:idea-abs` now passes 34 tests. Full TypeScript and focused lint pass.
The Idea Lab prompt correction also passed independent source review; older-session
capacity rejection was source-inspected but is not directly covered by the added test.
The final VPS artifact rebuilt successfully and six compiled/private-process checks
passed. Twenty-six earlier audit/role/rehearsal/news checks passed (overlapping suites,
not an additional unique-test total). No listener, feed, provider call or deployment.

Earlier component evidence:

Commits `db0bf3c` and `34e3bc8`; `pnpm test:idea-abs` runs 25 passing focused tests.
Full TypeScript passes. Focused lint passes. The initial batch compiled for VPS and
passed six compiled/private-process tests; these are not physical deployment evidence.
Independent source review identified late capacity checking and mismatched title/
provenance limits. Both findings were addressed and source re-reviewed without a new
concrete finding. No independent test execution or live acceptance is inferred.

## Still required for the requested outcome

Cancellation update: stop intent is retained in the existing HMAC-authenticated run
events instead of relying only on a caller-held callback. No new queue, service or SQL
table is introduced. An in-flight turn remains running until settlement; lost/invalid
results remain ambiguous. Recovery can finish a pending stop after a settled turn,
and repeated requests preserve the original intent. The current operator remains
repository-fake-only; live web commands are not enabled by this change.

Event append now locks the stable workspace row and separately rereads the latest
event, so version allocation does not rely on locking an immutable previous event.
Serialization is workspace-wide and limited to short SQL transactions, never provider
work. Future panel-writer provisioning must include the existing workspace row-lock
privilege. Head update time is monotonic even if an earlier-observed settlement obtains
the lock after a later stop request; actual attempt/request timestamps are not rewritten.
Independent review found both races and accepted the source remediations. Tests inject
stale first-statement visibility with different timestamps; real PostgreSQL overlap
acceptance is still required. Upgrade panel writers together: new readers accept old
records, but old binaries are not promised to understand the new optional field.

Run visibility update: the protected detail API and existing Idea page now display
retained panel history from the existing coordinator event store. Reads bind tenant,
workspace, session and digest; settled attempts must have corresponding returned
contributions, and completed panels require the full turn count. Multiple distinct
logical runs for one Idea fail explicitly. The UI never infers live connection from
saved running state and disables no gate: controls remain unconfigured. Only web-role
SELECT on run events was added. Two new tests exercise pending/completed synthetic
turns, uncertainty, browser projection validation and conflicting histories. Static
rendering is not interactive browser QA or real-provider acceptance. Source-only review
found no concrete introduced defect. The Sites skill preserved the existing private
interface and local-only delivery; no preview, imagery, Sites hosting or production change.

Creation composition update: the fixed offline `idea_creation_roles.sql` template and
`verifyIdeaCreationDatabase` cover only session creation/audit/session-authority needs.
The existing task lifecycle optionally owns this distinct resource and protects its
transactions with existing admission/precommit/drain/close handling. The combined
application rejects aliased clients, missing read configuration and differing integrity
keys, and mounts the owned save operation. No new service, queue or execution rights.
The task bootstrap now accepts explicit trusted configuration for this optional resource,
validates the roster/key/distinct-login topology before opening, and runs the exact
Idea role preflight before installing. It never provisions that role or supplies default
credentials. `IDEA_CREATION_SETUP.md` records the operator prerequisites and evidence
limits. A disposable three-role HTTP save/read/replay test passes; real operator
configuration, production database acceptance and deployment have not occurred.
`pnpm test:idea-abs` passes 56 tests. Separate task/private-process/compiled-app tests
pass 23 checks; TypeScript, focused lint and VPS compilation pass. Independent source
review found no concrete implementation defect; final added HTTP-composition and
failed/stalled-close tests were main-agent verified. Role tests have the existing explicit
PGlite-only TEMP-metadata exception and are not production acceptance. Lifecycle tests
use distinct wrappers over one disposable database, not distinct live PostgreSQL pools.

Storage update (`c522684`): migration 0059 and `PostgresAbsNewsStoreV1` now implement
immutable source versions, exact source/proposal reads, bounded pagination, and
source-bound proposal retention using the existing DatabaseClient/PostgreSQL stack.
No SQLite promotion, new database engine, role grant, feed or runtime activation.
Custom code is limited to Control Room's scoped story/proposal relationships; SQL
transactions, constraints and the existing validation/HMAC primitives do the storage work.
Independent source review found no concrete defect within the store/test scope.
The recomputed full private schema fingerprint is
`aac6f3f58ff464bf5d3a7227aa16efaf2beab0aba799db3b59b6248eff2f3a9f`.
Store/audit/database-role/rehearsal tests passed 27 checks in disposable PGlite;
this is not real PostgreSQL concurrent-worker or production migration acceptance.
Authenticated read/draft wiring and its SELECT-only role template are now implemented
above; actual deployment/migration and source ingestion remain open.

1. Supply and accept real operator configuration for implemented protected creation, then add protected
   Idea Lab run/cancel/synthesize/owner-decision commands. Private
   saved Idea and news pages are mounted; the separate demo build is not a live operator.
2. Complete ingestion and operational use of the implemented PostgreSQL store. Existing
   SQLite ABS stores and live-read simulation coordinators must not become production authorities.
3. Configure allowlisted news sources and reuse the selected normalization/deduplication
   helpers. Retain source attribution, freshness and failures. Do not label a source as
   verified solely because it supplies a digest. Large source packages need the existing
   artifact-storage path rather than dropping links to meet the text limit.
4. Route real bounded participant turns through admitted Hermes/Codex adapters. The
   protected operator remains repository-fake-only; this batch does not relax that gate.
   Preserve real discussion history, synthesis, owner promotion and project isolation.
5. Demonstrate article selection -> saved task -> eligible agent -> retained result ->
   review/revision, and multi-bot discussion -> owner decision -> separate project page.
6. Verify restart, disconnect, duplicate replies, revoked access, budgets and cancellation.
   Real configuration, provider calls and deployment need a consolidated scoped owner
   authorization; earlier one-shot qualifications are not reused permission.

Completion requires these actual journeys, not this component batch or synthetic tests.

Start integration update: `WebIdeaStartOperation` uses the existing coordinator, ledger
and current shared-session authority. It looks up separately accepted runtime material
outside owner SQL, reauthorizes, and atomically claims one persisted run plus audit under
the stable workspace lock. Only the claiming request executes; no owner transaction stays
open while a provider answers. Existing prepared, running and ambiguous histories are
inert replays, not automatic retries. Definite admission refusal can retain a pre-call
failure without guessing an unknown provider outcome.

The optional `POST /api/v1/ideas/:id/start` route accepts only bounded JSON through the
existing same-origin and verified identity boundary. Runtime evidence/admissions are
server-held, never supplied by that request. Missing composition returns unavailable;
there is no fake fallback. Ten focused tests pass with injected authorities/drivers and
serialized PGlite, including rollback, revocation during lookup, concurrent lookups,
interrupted prepared claims, HTTP bounds and logout. Independent source review found
no concrete defect; it did not execute tests. Actual independent PostgreSQL pools,
managed runtime role and lifecycle ownership, browser start controls and live acceptance
remain required. In particular, the optional HTTP route is not proof of configured
production execution or bounded physical cancellation at shutdown.
