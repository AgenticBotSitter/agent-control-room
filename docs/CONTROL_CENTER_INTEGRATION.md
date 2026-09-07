# Control Center integration: reuse the news product

Updated 2026-09-07. Active user goal: finish integrating public Control Center into
Control Room, borrowing as much as makes sense. This supersedes continuing the
custom feed-startup sequence as the default next step. Existing local work stays saved.

## Source and evidence

Public source: https://github.com/mreflow/control-center at
`d13e79e866cc33a1fddfe84f563ce2fb9a2113e0` (public tree API still returned this revision
at inspection). MIT, copyright Matt Wolfe; preserve LICENSE and notices. Current
upstream package manifest requires Node >=24.19; our Node 22 baseline cannot be called
qualified for the whole app. Source presence and upstream tests are not a local run.

The earlier integration borrowed only event helpers. It did not adopt the news
pipeline. Corrective direction: adopt cohesive discovery, curation and presentation
modules; change boundary adapters, not recreate all their internals.

## Cohesive adoption blocks

Checkpoint: the discovery source cohort and 20 upstream tests are now retained;
three additional tests exercise its explicit source-reader port through HTML-feed
and robots-sitemap flows. Network and snapshot storage ports are not yet connected
to the production application. This advances source adoption, not completion gates.

Storage bridge: `AbsControlCenterIngestion` translates a captured reader result into
existing scoped story/source records through shared ingestion persistence. Borrowed
ranking remains in use; no second ranking engine was added. The adapter requires
source ID/name/input URL to match, carries RSS/Atom/sitemap evidence and treats
partial coverage explicitly. Logical collections now span 100-item storage batches
inside one transaction, with one aggregate source observation and authenticated
receipt. The input/receipt ceiling matches the upstream 100,000 sitemap-entry limit;
this is not a production performance qualification. A complete 250-story borrowed
feed is tested for receipt verification, replay and pagination; a forced failure
in batch two rolls back all articles, source state and baseline. Larger receipts
require updated writers and readers together: older readers capped at 100 reject
them. Live collection remains unwired.
This bridge is not the whole configured application or visible news page.

Baseline integration now uses migration 0062 rather than upstream filesystem writes.
Call `loadBaseline()`, pass its result to the borrowed `readSource(source, baseline)`,
then pass the same baseline as the third argument to `ingest(result, observedAt, baseline)`.
The adapter's `collect(reader, signal, clock)` now performs that composition directly
for an application-supplied borrowed reader. It checks abort before reading and
before committing, using the existing database pre-commit mechanism. It does not
create a transport or authorize a destination; the application must supply the
bounded authorized reader and handle cancellation of its physical reads. Source
failure propagates without advancing memory; failure-status persistence remains
part of the later application wiring. No live runtime is mounted by this helper.
The adapter atomically saves accepted stories, source outcome and the new snapshot.
Competing baseline changes reject and roll back; rejected items leave memory unchanged.
Snapshots retain the upstream format, with a 100,000 URL / 8 MiB storage ceiling;
oversized results fail without silent truncation. These are storage bounds, not grants
for live collection. No second database, scheduler or discovery algorithm was added.

| Block | Upstream source | Integration decision and necessary differences |
| --- | --- | --- |
| Discovery ranking | lib/industry-curation.ts | Complete unchanged module now retained and invoked by feed decoding. Includes scoring, deduplication, selection, diversity, exclusions and deferral. Keep upstream IDs as presentation identities only. Preserve all canonical stories. |
| Source discovery | lib/server/rss.ts, lib/feed-discovery.ts, lib/sitemap.ts, lib/freshness.ts | Next adopt as a group with upstream tests. Inject reader and snapshot storage at their boundaries; preserve feed/HTML discovery, sitemap fallback, undated baseline and partial-coverage handling. No custom replacements for these algorithms by default. |
| Public fetching | lib/server/safe-fetch.ts, pinned-fetch.ts, public-address.ts | Evaluate together with discovery. Upstream already supplies public-address checks and pinned requests. Adapt cancellation, total read/byte budgets and allowed-source boundaries; do not assume a second custom HTTP engine is required. |
| Reading view | lib/industry.ts, daily-brief-snapshot.ts, components/daily-snapshot.tsx and relevant Industry sections of components/control-center.tsx | Adopt presentation and saved-queue flow. Main component is 3,795 lines and includes unrelated products; extract the Industry slice instead of importing the entire shell. Add project binding and Research/Setup/Compare/Draft actions. |
| Persistence | industry-store.ts, collector-cache.ts, archive-store.ts | Preserve discovery/history/archive semantics; adapt SQL/storage access to our PostgreSQL project scope. Upstream node:sqlite and filesystem snapshots are not another global write authority. |
| Scheduling | lib/server/scheduler.ts | Keep pg-boss as the existing scheduler. Upstream uses process timers and loopback refresh URLs; importing those would create duplicate schedules, not reduce work. |
| Agent work | lib/tasks.ts versus existing Control Room task workflow | Keep existing agent assignment/results/review. Inspected upstream tasks module manages reminder completion/recurrence; it does not supply the requested cross-machine agent workflow. Connect selected articles into our ordinary task path. |

## Avoid incompatible silent changes

`createControlCenterCollectionReader` now wraps the borrowed source/fetch modules
with existing current-source assertions, HTTPS validation, physical-attempt limits,
shared deadline/cancellation and a conservative per-document body reservation.
Pass `reader.signal` to ingestion's `collect(reader, reader.signal)` so persistence
uses the same deadline. It requires explicitly supplied DNS/transport dependencies;
there is no default connection or runtime mount. Reservation counts maximum decoded
body bytes per logical document, including failed documents, not total wire traffic.
Redirect destinations are checked before DNS; each pinned attempt rechecks authority.
Configured source persistence/UI and application startup/queue wiring remain open.
Source and discovered endpoint query strings now use one dedicated endpoint schema
across fetch, ingestion and baseline storage. Exact queries are retained for source
identity and evidence; article canonical URL rules remain unchanged. A full injected
HTML-alternate-feed collection test proves query endpoints through restart storage.
Only public feed selectors belong here, not private signed links or credentials;
query support grants no access and exact-destination authority is still required.
Current limits are decoded-body reservations, not a measurement of all bytes on
the network; HTTP headers/redirect-body transport cleanup require native validation.

Public HTTP cohort is now retained in `src/vendor/control-center/`: complete
upstream address classification, pinned request implementation and safe-fetch module.
Tests inject both DNS and transport (no native requests), including the full 250-item
reader/storage test through safe-fetch. A review found pre-aborted requests could
launch DNS and leave a rejection unobserved; the small documented patch checks abort
before lookup and observes already-created promises. This code is not runtime-mounted.
Before wiring, impose configured-source authority, HTTPS-only destinations, a shared
collection deadline/cancellation signal, total requests/bytes and cleanup accounting.
Upstream supports HTTP and multiple address attempts; its defaults are not our grants.

Reading integration now retains the complete upstream `lib/industry.ts` and an
adapted daily-snapshot component in the actual private project news page. It offers
recent/history/archive views and important/newest/oldest sorting over each saved
page, preserving existing pagination and research preparation. Projection metadata
adds source, score and discovery date; missing legacy metadata remains supported.
The upstream ten-minute future tolerance remains unchanged. Archive mutation,
whole-library filtering/ranking and source configuration are now integrated locally.
Explicit startup composition supplies refresh operations, but live transport and
browser acceptance remain unproven. Compilation and pure tests do not prove them.

Upstream discovery makes multiple feed/sitemap requests, supports redirects and uses
larger defaults (10 MB feed, 50 MiB sitemap, 500 sitemap documents). Current custom
single-endpoint admission cannot represent that operation. Define one bounded logical
collection with explicit source/read/byte/time limits before wiring live discovery;
do not disguise fan-out as a one-request job or automatically enable upstream timers.
This is a contract adjustment for the requested product, not a reason to rebuild
upstream discovery. No live network/provider authority is created by adopting source.

Discovery ranking is advisory. Its soft per-source cap is retained for discovery,
not substituted for the current verified digest hard cap. Feed evidence is still
review-only. Canonical-page verification and article-to-agent task acceptance remain.

## Completion gates

### Archive and restore integration

The existing borrowed reading views now have owner-only Archive/Restore actions.
Migration 0064 stores immutable project-scoped choices separately from immutable
source versions, so recollection does not resurrect archived articles or change
evidence digests. PostgreSQL supplies this persistence instead of adopting upstream
SQLite as a second write authority. The existing web authentication, auditing and
exact-save/replay conventions are reused; these actions start no collection or agent
work. Restore places previously archived source records in History.

Filtering uses authenticated classification snapshots, not raw overlay columns that
could exclude corrupt rows before checking their signatures. The current explicit
bound is 100,000 classified article identities per project, with read batches of
1,000; new identities are refused at that bound, existing choices remain editable.
This is bounded local correctness evidence, not production performance evidence.
The browser preserves unresolved exact requests and reloads authoritative ranked
pages after confirmation. Restricted-role HTTP tests and client lost-response tests
pass. Independent source-only re-review of fdb8a89 accepted the earlier filtering
correction and found no new concrete defects. Browser interaction acceptance and
production database performance remain outstanding.

The borrowed-collector/library regression now covers configured collection, archive,
recollection with changed source content, retained old evidence, authenticated receipts,
and restore through the borrowed reading projection. Each collection and web service
is reconstructed over the same disposable database. All eleven ingestion tests pass;
this does not claim a physical process restart, live network or browser run.

### Library browsing

History, Archive and Recent are now database-level selection over each story's
latest retained version before the 50-story page limit. The authenticated news API
accepts one `view=all|history|archive|fresh`; old clients retain `all` by default.
The page preserves its selected view during pagination and starts from the first
matching story when switching views. The PostgreSQL adapter imports the borrowed
freshness constants; the borrowed presentation/sort modules remain unchanged.
This avoids loading the whole library into application memory. Summary counts and
the daily snapshot remain page-local; archive/restore mutation remains unfinished.
View switching performs no collection or agent action.

The API also accepts one `order=id|important|newest|oldest`. Existing clients default
to ID order; the reading page defaults to importance. PostgreSQL applies the borrowed
priority-then-date/newest/oldest rules before pagination, with C-collated ID ties for
stable storage ordering rather than locale-dependent JavaScript ID ties. This is a
database pagination adapter, not a replacement scoring algorithm. The existing
borrowed browser presentation is retained. View/order switches reset the cursor;
next-page links preserve both. Ranked pagination anchors on the retained story ID;
a missing or newly excluded anchor returns no records and requires starting over.
Concurrent collection updates are not a frozen snapshot. Tests compare a 63-story
two-page cohort against upstream ordering and require no omissions/duplicates.
Timestamp fractions are truncated to three digits before PostgreSQL parsing so
its higher-precision rounding cannot disagree with the borrowed JavaScript
millisecond rules. A boundary regression uses nanosecond-precision input and compares
the selected records directly against upstream freshness and sorting functions.

### Open product decision: research on discovered articles

The actual borrowed-collection-to-web path saves `review_only` articles. Under the
current CR9D contract, `WebNewsService.prepare` refuses even `research_brief` with
HTTP 409 until separate canonical-source verification has occurred. A regression
now makes this end-to-end limitation explicit; successful collection/startup does
not prove the requested news-to-research workflow.

Owner direction has been requested on allowing verification-first research of an
unverified article. Recommended: keep the article unverified, pass its exact retained
discovery evidence as untrusted research input, and hold the result for review.
Do not enable publication, setup execution or other consequential actions by this
choice. Until approved and implemented in the normative contract and task boundaries,
the existing refusal remains in force. Alternatively, retain the separate verifier
gate and build its direct-page evidence path before any proposal.

### Startup composition

`createPrivateTaskBootstrap` now accepts explicit top-level `news` configuration:
source assignments, coordinator/ingestion/worker database configurations, the same
integrity key used by web news storage, supplied current-source authority and supplied
DNS/HTTP ports. All logins must be distinct and address the existing private primary.
It verifies news coordinator and ingestion roles before preparing submission and
mounting collection operations. The worker factory remains responsible for its own
fixed worker-role preflight. No production roles are created or repaired by startup.

Server composition can supply `createInstalledNewsQueueFactories({openWorkerDatabase})`
to the existing bootstrap dependencies, alongside native factories when needed. This
uses the installed pg-boss package and existing news queue; it does not download or
enable anything at import/construction. There is no default live DNS/HTTP port or
news configuration in the production singleton. An operator must supply qualified
ports and pre-provisioned resources before activation.

The mounted app includes news resources in readiness and cleanup. Workers drain
before the news producer and pools close. Failed or late asynchronous factory results
retain cleanup ownership; an uncertain factory is not retried. Tests cover restricted
roles, route mounting, failed role checks, producer/worker factories, installer failure
and exact cleanup. Class/private-field worker status and close methods are exercised;
producer enqueue receiver binding is source-reviewed, not invoked by this startup
fixture. The fixture uses minimal queue ACL tables and a fake worker: actual pg-boss
polling, native transport, PostgreSQL connections and full live workflow remain gates.
Run `pnpm test:news:startup` for the local startup regression; it starts no physical
worker service or listener and uses disposable database/factory fixtures.

### Private web connection

`createNewsDiscoveryIntegration` assembles per-source web operations and one routed
`collect` callback for the existing news queue worker. The caller supplies separately
verified coordinator/ingestion clients, a prepared transactional submission service,
current-source authority and qualified transport ports. Construction opens nothing.
Duplicate source assignments, cross-workspace scope and conflicting project workers
are refused; execution requires a retained plan matching a registered configuration.
The caller must stop/drain the worker before closing supplied resources. This helper
does not replace production role preflight or own application startup. Basic startup
rejects unsupported collection operations rather than silently ignoring them.
The existing `composePrivateTaskWorkerApplication` now accepts a captured worker
list, so native-task and news workers can share one application lifecycle. All must
be accepting before the combined app reports ready. Shutdown gates new web requests
and attempts bounded drain of every worker before application cleanup; any drain
failure or timeout remains cleanup uncertainty, not proof of physical termination.
Single-worker callers retain compatibility. The startup composition above now opens
and verifies the supplied news pools and mounts it; deployment configuration and
qualification remain separate requirements.
An injected integration test now submits a fresh proposal and approval through these
assembled HTTP bindings, consumes the queued reference with the borrowed collector,
and confirms the same story is not duplicated after another completed refresh.
Admission now also checks retained plans with unresolved effects while holding its
existing workspace transaction lock. Different request keys for the same source
cannot both enqueue; exact replay returns its original receipt. Ambiguous effects
continue to hold the source until resolved. Confirmed, failed or cancelled effects
release it for a new explicitly approved refresh. This uses existing tables, not a
second scheduler or lock service. A concurrent distinct-key regression checks one
admission, one refusal, one effect and one queue entry.
This does not prove real queue polling,
native networking, production bootstrap or browser interaction.

The private process accepts explicitly supplied, project/source-bound collection
operations and exposes GET `/api/v1/projects/:project/news/sources/:source/collection`
plus POST `/propose` and `/approve` beneath it. GET describes the configured source,
origins, limits, digest and current owner ability to refresh, without starting work.
Unconfigured sources report `configured:false` after project authorization. Existing
same-origin and identity checks, bounded JSON and no-store responses apply. Callbacks
are captured at construction; duplicate bindings and cross-tenant/workspace entries
are refused. This creates no reader, pool, schedule or runtime by itself.

Route source IDs are passed separately from request JSON into admission and compared
with the retained plan before any approval changes. Review found this was initially
missing: a same-project second-source job could use the first source's URL. The
regression now requires rejection and zero approval/effect/attempt/queue writes.
The injected discovery journey uses these mounted HTTP routes for description,
proposal and approval before consuming the saved queue reference. Source cards now
mount `NewsSourceRefresh`, with explicit options/prepare/approve steps and the existing
navigation guard. Parent source edits, saves and pagination are held while a refresh
request is uncertain. The client retains exact proposal/approval requests after lost
responses and access denial; no automatic retry or approval occurs. Checked descriptor
changes disable new approval until the prepared digest is confirmed current again.
Admission receipt state is labeled as recorded history, not a live completion signal.
Production startup supplying these operations and visual/browser acceptance remain open.

### Discovery job integration contract

The existing plan builder/store now accepts `control-room.abs-discovery-plan/v1`
alongside the unchanged legacy single-feed plan. It produces ordinary proposed
request/workflow/job records, with `abs-news-discovery/v1`, `abs.news.discover` and
`news.public_discovery.read`. Job type and existing immutable plan storage are reused;
no second scheduler, queue table or persistence engine is introduced.

The complete input digest binds the source ID/name/URL, saved revision, project,
up to 16 explicit public HTTPS origins, shared deadline, physical-attempt ceiling,
per-document decoded-body ceiling and aggregate decoded-body reservations. Origin
entries are exact, unique and include the source origin; no hostname suffix wildcard,
private address, credentials, path or query is allowed in an origin. Feed endpoints
can retain public query selectors. Within approved origins, the borrowed algorithms
may discover new paths/queries; additional origins require a different approved plan.
This distinction is necessary for HTML alternate feeds and sitemap discovery.

Authenticated proposal reuses the existing owner/project checks and saves only when
the source is enabled and the revision/name/URL match. The plan is still proposed:
no lease, approval, network or queue action is created by proposal. Admission now has
an explicit trusted `discovery` mode; the default still accepts only legacy feed plans.
Discovery admission rechecks the saved setting before atomically authorizing and
queueing the existing locator-only job reference. Execution requires explicitly
supplied discovery transport ports, rechecks the source before the durable attempt
marker, and invokes the borrowed collector. Each destination is intersected with the
plan's origins and current local authority; the commit also rechecks current authority.
Canonical attempt/settlement retains owner, approval, lease, digest and duplicate
protection while recognizing the separate discovery spec, operation and capability.
Verified receipts settle the ordinary job; uncertainty does not authorize another read.
This composition is injected-test evidence, not application startup or native operation.
Native transport cleanup and runtime qualification remain open.
Offline coordinator grants/preflight now add source-settings SELECT only. Restricted
role tests prove proposal, replay and saved-plan retrieval, with settings INSERT denied.
Disabling a source as owner then retrying as the restricted coordinator is refused.
No production permission change has been applied.

The job-facing `createControlCenterCollection` now exposes single-use `collect(signal)`
and memoized bounded `close()`, composing the configured collector and borrowed reader.
It starts nothing at construction and requires supplied transport/current authority.
Tests exercise cancellation and verifiable completion without native requests.
Logical settlement is not evidence of physical socket cleanup. Existing
`abs-feed-plan/v1` grants a single fixed RSS/Atom collection; do not inject this broader
discovery collector under that unchanged job contract. The separate discovery plan
now binds source revision, destinations and total limits and uses the same attempt
settlement. Startup must qualify and compose the reader and existing queue runtime;
there is no separate discovery scheduler.

Configured collection now composes saved source settings with the borrowed reader
through `collectConfiguredControlCenterSource`. The caller supplies an already
authorized bounded reader and expected source revision. Missing, disabled or changed
settings reject before reading or before publication; the final settings check shares
the ingestion transaction and workspace lock. Settings edits during a read are tested
to leave no new stories, observation or baseline. Offline ingestion permission is
SELECT-only for settings. This is application composition, not a mounted refresh route,
job admission or live-network qualification.

Source setting persistence now uses PostgreSQL migration 0063 and
`PostgresNewsSourceSettings`: upstream id/name/url plus enabled, scoped by project,
with authenticated revisions and expected-version writes. Restart, disable, conflicts,
scope isolation and paginated listing are tested. This replaces neither source
authority nor scheduling. Authenticated GET/POST `/api/v1/projects/:id/news/sources`
now exposes settings: project read permission for listing, owner-only
`news.sources.manage` and active project for edits. Audit and setting commit together.
The offline private-web role/preflight adds only source-settings SELECT/INSERT;
no live role change occurred. The private news page now includes source controls
for name/URL, enabled state, edit/add and pagination. The browser client validates
project/record/revision responses and keeps an exact pending save across uncertain
responses, including a later denied retry. Navigation is held while a save is pending.
These controls save settings only; they do not collect or schedule. Visual browser
acceptance remains outstanding; build/render and injected HTTP tests are not visual QA.
Reason for this adapter rather than upstream settings persistence: one shared private
PostgreSQL authority and project/session permissions, not machine-local global settings.

Article action connection: the existing authenticated prepare/save flow now exposes
research, setup guide, product comparison and article draft, using the existing
ABS action/proposal catalog and ordinary project tasks. Four-action tests save and
replay distinct proposed tasks with retained source evidence; unverified stories
are refused for every action. No separate upstream reminder/task system was adopted.
This proves preparation and local persistence, not an agent run/result/review or
publication. Canonical verification of newly collected stories remains required.

1. Adopt discovery/curation cohort with provenance, upstream fixture coverage and
   focused adapter tests; record every deliberate upstream change.
2. One visible project news page supports configured sources, saved stories, fresh/
   history/archive views, source failures and manual refresh without duplicate scans.
3. Owner selects an article, requests research/setup/comparison/draft, and receives
   an ordinary project task with stable article evidence. No new parallel task system.
4. Eligible agent completes the task; retained result is visible and reviewable.
5. Restart/cancellation/partial source failure preserve saved state and do not cause
   unintended duplicate effects. Qualify the actual supported runtime and database.

Discovery, curation, atomic persistence and restart memory are connected locally,
but the visible configured workflow and live acceptance gates remain unfinished.
No repository-wide adoption percentage is claimed.
