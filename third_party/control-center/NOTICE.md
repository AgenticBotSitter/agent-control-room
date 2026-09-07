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

`tests/control-center-discovery-upstream.test.ts` retains 20 selected tests and two
fixture builders from upstream `tests/industry.test.ts`; only imports and the test
subset changed. Local source-reader integration tests are additional Control Room
evidence. Upstream defaults are not approved production ceilings; the reader port
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

Original source SHA256 (LF text retained in E03):
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
