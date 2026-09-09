# Control Center attribution and adaptation

## Discovery cohort adoption (2026-09-07)

Storage-bridge follow-up: `source-reader.ts` also exposes captured `sourceUrl`,
machine-readable `coverageComplete` and RSS/Atom `feedKind`; source input and prior
snapshot are copied before asynchronous work. Feed format uses the existing XML
parser, not a new XML implementation. This binds results to their configured source
without confusing the discovered feed endpoint with the input homepage. No discovery
ranking/fallback rule changed. These metadata changes are Control Room adaptations.

Same revision and MIT license below. Retained complete `lib/feed-discovery.ts` and
`lib/types.ts` unchanged; `lib/freshness.ts` and `lib/sitemap.ts` change only their
type-import path to `./types`. `lib/server/rss.ts` becomes `source-reader.ts`:
imports are local, reader functions are enclosed in `createIndustrySourceReader`,
network text reads and clock are captured injected ports, and local-file snapshot
load/save functions are omitted. Feed probing, sitemap fallback, baseline and
partial-coverage algorithms are retained. The general atomic-write helper remains
in sitemap source but is not invoked by this integration.

Development comparisons retained 20 selected tests and two fixture builders from
upstream `tests/industry.test.ts`, adapting imports and the test subset. This
provenance does not imply that every development test is included in this preview. Upstream defaults are not approved production ceilings; the reader port
must enforce total authority/budgets before live use. No SQLite/settings/scheduler
or ambient network client is imported by the source reader.

## Complete curation module adoption (2026-09-07)

`src/vendor/control-center/industry-curation.ts` now retains the complete original
`lib/industry-curation.ts` from the revision below, without implementation changes.
The feed decoder uses its scoring and complete discovery curation (deduplication,
ranking, diversity, exclusions and deferral). These are discovery recommendations:
all valid stories remain stored, canonical IDs are unchanged, and ranking never
grants verification or task authority. Its soft source-diversity behavior is retained
for discovery; the existing verified digest contract is not silently replaced.
The smaller event adaptation below remains used by that verified digest.

Source: https://github.com/mreflow/control-center
Revision: `d13e79e866cc33a1fddfe84f563ce2fb9a2113e0`
Original file: `lib/industry-curation.ts`
Copyright (c) 2026 Matt Wolfe. MIT; full notice in `LICENSE` alongside this file.

Original source SHA256 (LF text):
`ad668fe4bf08e7b48913b43ef7edb05edbe4d874db1a16c451ff006e0b70d962`.
Original LICENSE SHA256:
`a149b592d1e38b71a4ff4987ee9020b5f35a5fe7c2f09ebdc78ae9ec7a87349b`.

Adapted path: `src/vendor/control-center/industry-events.ts`.
Adopted text cleaning, Unicode title normalization, title stop words, token overlap,
provider-wrapper recognition and sparse generic-title exception. These are pure
helpers; no upstream database, process, dependencies or network defaults were imported.

Control Room changes: event-only data type and precomputed tokens; omit hash-based
identity/shortcut, ranking and URL normalization; preserve distinct numeric model/
version/date tokens rather than treating them as the same event. All eligible ABS
stories have already passed verification. The sparse-title exception is broadened to
all short token sets on different/unknown direct URLs, not just identical normalized
titles: the first integration run exposed four regressions where distinct short
headlines lost their single-letter distinctions. A comparator has no authority to
verify a story or approve a fetch.

Integration: `selectAbsNewsDigestV1` uses this helper to defer likely duplicate events
across different existing cluster IDs. Existing canonical IDs, story/evidence digests,
strict source cap, score order and verified/freshness filters remain intact. This does
not overwrite or merge source records. Retain this notice and LICENSE when distributing
the adapted helper.
# Reading view adoption (2026-09-07)

From mreflow/control-center revision d13e79e866cc33a1fddfe84f563ce2fb9a2113e0,
MIT, copyright Matt Wolfe. Existing LICENSE applies.
`src/vendor/control-center/industry.ts` retains complete `lib/industry.ts` with
only imports changed to local relative paths. Sorting, library partitioning and
freshness composition are upstream code.
`private-app/app/news-daily-snapshot.tsx` adapts `components/daily-snapshot.tsx`:
one news category instead of three, existing theme/classes instead of CSS module
and lucide icons, project story fields and page-scoped wording. Upstream stylesheet
was inspected but is not retained. No new icon/style dependency installed.
`news-reading-view.ts` is Control Room field translation, using publication date
or discovery date for ordering/freshness while retaining the original story fields
for display and evidence. No collection, archive writes or task authority is added.
# HTTP reader adoption (2026-09-07)

Retained full upstream `lib/server/public-address.ts`, `pinned-fetch.ts` and
`safe-fetch.ts` at d13e79e866cc33a1fddfe84f563ce2fb9a2113e0 under
`src/vendor/control-center/`. MIT, copyright Matt Wolfe; existing LICENSE applies.
Changes: local imports, remove framework-only `server-only` marker, pass the
existing optional pinned-fetch dependency seam through the two safe-fetch exports.
Address classification, address pinning/racing, redirect loops and body bounds remain
upstream. Not production-mounted; no claim of total collection budget, source grants,
HTTPS-only policy or native-runtime qualification. Tests supply fake DNS and fetch.
Review correction: reject pre-aborted resolution before scheduling DNS, and observe
an already-created promise when abort wins. This avoids needless lookup/unhandled
rejection; an injected rejecting-lookup regression proves no DNS/transport call.
Application integration hooks in safe-fetch: optional shared cancellation signal and
synchronous per-hop `beforeRequest`, applied before pinned DNS resolution in both
text fetching and redirect resolution. Asynchronous guard returns are refused.
Control Room's separate adapter reuses this module with configured HTTPS authority,
physical-attempt cap, per-document reserved decoded-body budget and shared deadline.
