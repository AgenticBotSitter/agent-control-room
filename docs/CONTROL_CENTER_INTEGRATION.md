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
Discovered endpoint query strings are accepted by the fetch guard but still need
reconciliation with the stricter ingestion endpoint schema before live wiring.
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
whole-library filtering/ranking, source configuration and live refresh still need
integration. No visual/browser acceptance is claimed by compilation or pure tests.

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
