# F7: existing Control Center reuse and news-to-research reconciliation

2026-09-08. Baseline `29dbc4a`, branch `codex/idea-abs-workflows`.
Scope C3/C4/C5 existing implementation, not additional candidate discovery. No
application changes, downloads, installs, sockets, provider calls or GitHub operations.
New candidate dossiers are separately owned by the lead comparison agent.

## Direct finding

**Control Room is already substantially using Control Center's implementation.** It
is not merely referencing the upstream README or rebuilding the whole collector.
The news journey's remaining work is primarily live integration, source/worker
qualification, operators and product acceptance. There is one concrete consolidation
opportunity: two supported feed-decoding paths and duplicated field translation.
Removing either immediately would change currently tested semantics.

## Exact borrowed scope and ownership

Source `mreflow/control-center`, pin
`d13e79e866cc33a1fddfe84f563ce2fb9a2113e0`, MIT, copyright 2026 Matt Wolfe.
Full retained notices: `third_party/control-center/LICENSE` and `NOTICE.md`.
[Local inventory](f7-integrated-inventory.json) records all 11 vendor files, **2,137
lines including types/comments**, current SHA256 and bytes. These are current local
snapshots, not claims every file remains byte-identical to upstream.

| Borrowed files under src/vendor/control-center | Actual current use / adaptation |
| --- | --- |
| industry-curation.ts, 511 lines | Complete upstream scoring, curation, exclusions, deduplication and diversity. Used by both feed-decoder and control-center-ingestion. Current hash exactly equals recorded original `ad668fe4...0d962` |
| feed-discovery.ts, 27; sitemap.ts, 414; source-reader.ts, 261 | Feed-link probing, RSS/Atom/RDF parsing, sitemap traversal, quiet baselines/undated observations, partial coverage. Reader enclosed in factory with injected text/clock; local snapshot storage omitted; source/coverage/feed-kind metadata added |
| safe-fetch.ts, 89; pinned-fetch.ts, 228; public-address.ts, 98 | Borrowed public-address filtering, pinned resolution, redirect/body bounds. Existing seams receive captured per-hop authority/cancellation/budget checks. Not ambient-network authority |
| freshness.ts, 32; industry.ts, 75; types.ts, 324 | Reading-view sort, history/archive partition and freshness. Types imported locally. news-reading-view translates canonical project stories without changing identity/evidence |
| industry-events.ts, 78 | Adapted title/event conflict subset for verified digest. Numeric/version distinction and sparse-title behavior intentionally differ; not a replacement ranking engine |

`private-app/app/news-daily-snapshot.tsx` additionally adapts the upstream daily
snapshot component; styling/icons use our existing UI. Full upstream stylesheet is
not retained. HTTP/reader functions are genuinely used by `createControlCenterCollection`
and `createNewsDiscoveryIntegration`; legacy comments saying unmounted are not evidence
that no composition exists. **Composition exists, production activation not established
by this evaluation.**

The current license SHA256 also exactly matches the recorded original
`a149b592...7349b`. No upstream reacquisition was made; provenance rests on retained
notice/history plus direct current hash comparison, not fresh GitHub authentication.
Installed `rss-parser@3.13.0` and `fast-xml-parser@5.11.0` package manifests both say
MIT. Reading fast-xml-parser via package exports initially failed because package.json
is not exported; direct local manifest inspection succeeded. No installer was needed.
Full transitive license audit belongs to F9; root MIT alone is not blanket clearance.

## Existing end-to-end path, verified at the correct scope

1. `createControlCenterCollection` captures source configuration/authority/key and
   uses `createControlCenterCollectionReader` with injected bounded transport.
2. Real borrowed source reader discovers a feed from the supplied homepage HTML and
   parses supplied RSS through its existing XML implementation.
3. `AbsControlCenterIngestion` binds configured source, project/tenant/workspace,
   evidence digests and immutable story versions; source baseline commits with data.
   Discovery stays **review_only**, even when ranking selects it.
4. Actual private HTTP news API returns the recorded story. Its prepare operation
   creates a verification-first ordinary task draft with exact story digest/source URL.
5. Existing `/tasks` save persists once; replay returns the same receipt and does
   not start an attempt. Planner binds the original source task/input digest into
   the executable task plan; same provenance reaches native-task contracts.
6. Existing synthetic native lifecycle fixture supplies result bytes. Actual result
   intake, stored artifact read authorization, structure verification, owner-review
   service and completion service require verification/review before success.
   Replays do not duplicate accepted reviews or synthetic effects.

This path is executed by `tests/abs-research-native-journey.test.ts`: **1 passed**.
It verifies the exact collected story becomes the exact saved/planned task whose
result is ingested, reviewed and completed. It is **E3 in-process application fit**,
not a real provider/agent run. Fake DNS/fetch, synthetic assertions, fake native
process/results and document-structure acceptance are explicit test dependencies.
The quality text is not evidence that an article's claims were truthfully researched.
No socket, pg-boss worker, real PostgreSQL service or real owner approval was used.

## What is duplicated, and what should stay distinct

| Seam | Current evidence | Action / deletion boundary |
| --- | --- | --- |
| Two XML/feed libraries | Direct feed-decoder uses rss-parser; borrowed sitemap/source-reader uses fast-xml-parser. Both live routes remain selected by feed-job-execution's plan schema | Candidate consolidation after compatibility tests/migration; not delete merely because both parse XML |
| Story translation | feed-decoder.ts 98 lines and control-center-ingestion.ts 114 lines repeat canonical URL, title/summary, timestamp, digest/source evidence and story shaping | Extract a shared bounded material-to-story mapper (~35–60 repeated lines estimated), preserving distinct input validation/provenance/baseline transactions. Zero removal performed |
| Discovery scoring | Both paths call actual same 511-line upstream functions | Already reused; no custom ranking engine to replace. Repeated call/field projection is glue, not independently rebuilt scoring |
| Discovery curation vs verified digest | Upstream discovery keeps soft source diversity/exclusions; digest-selection.ts enforces verified-only, hard source cap, immutable evidence, canonical cluster identity | Retain separate policy wrapper; do not replace verified digest with recommendation logic. industry-events adapts common matching with explicit version/sparse-title exceptions |
| Canonical URL policy vs upstream display URL normalization | Our collection.ts rejects non-HTTPS, credentials, ports, unapproved query keys, local names; upstream normalization serves discovery grouping | Retain authority/identity guard, or replace only with proven exact policy adapter. A borrowed relevance normalizer cannot become fetch authorization |
| Queue vs collector | pg-boss existing submission/worker orchestration is separate from actual collector body | Keep one queue engine; Control Center collector is not a reason to import its SQLite settings/scheduler |
| Reading UI | news-reading-view delegates sorting/partition/freshness to actual industry.ts | Already reused; do not write another archive/freshness sorter |

New research-only [parser comparison](../../../research/reuse-comparisons/f7-parser-comparison.test.mjs)
executes both currently installed real paths using the same synthetic RSS bytes:

- Ordinary dated RSS fields agree after timestamp normalization.
- Missing title / relative URL: direct decoder rejects both entries; borrowed parser
  supplies `Untitled update` and resolves the relative URL. Therefore dropping the
  old parser is **not currently proven behavior-compatible**.
- 101-item feed: bounded direct decoder rejects over its configured 100-item ceiling;
  borrowed parser returns 101 (its own fixed cap is 250, applied after sorting).
  A wrapper must preserve configured rejection/partial-coverage semantics before
  removing a path, not silently weaken the old limit.

All **3 comparison tests pass**; two intentionally preserve mismatch evidence. This
does not say either upstream parser is broken. It identifies precise policy decisions
and loss of raw missing-title information that a unification adapter must address.
Potential eventual savings: one parser dependency and a portion of 212 adapter lines,
**not** all those lines. Legacy plan/receipt/source kinds still exist and cannot be
rewritten without migration. Exact removable total remains unproven; current deletion0.

## Commands executed serially

Each process finished before the next started. No persistent acquisition/service root.
PGlite tests use existing disposable fixtures and close databases. No full heavy suite.

```sh
node --import tsx --test --test-concurrency=1 tests/control-center-discovery-upstream.test.ts tests/abs-news-feed-decoder.test.ts tests/news-reading-view.test.ts tests/abs-news-digest-selection.test.ts
# 39 passed / 0 failed, ~1.32 s suite duration
node --import tsx --test --test-concurrency=1 tests/abs-research-native-journey.test.ts
# 1 passed / 0 failed, ~1.94 s
node --import tsx --test --test-concurrency=1 --test-name-pattern='borrowed collection.*archive|borrowed collection lifecycle|configured collection uses' tests/control-center-ingestion.test.ts
# 4 matching tests passed / 0 failed, ~2.43 s; not the full file
node --import tsx --test research/reuse-comparisons/f7-parser-comparison.test.mjs
# 3 passed / 0 failed, ~0.17 s
node --import tsx --test --test-concurrency=1 tests/web-abs-research.test.ts tests/control-center-fetch.test.ts
# 13 passed / 0 failed, ~2.60 s
pnpm exec eslint research/reuse-comparisons/f7-parser-comparison.test.mjs
git diff --check
# both passed
```

Total **60 checks across five invocations**, not 60 end-to-end journeys. They cover
adopted discovery behavior, feed parsing/curation, verified digest, reading views,
one collected-story-to-reviewed-result journey, archive/recollect/restore, disabled
source/config revision refusal, inert/single-use cancellation, redirect authority,
address pinning/private-address refusal, budgets, stale results, missing/foreign
login and once-only research-task save/replay. Durations are runner timing, not a
resource/throughput benchmark. Runtime emits an existing experimental SQLite warning;
no assertion or process failure occurred. No production memory estimate is inferred.

## Remaining F7 work and next useful experiments

- Live authorized source/transport qualification and sustained pg-boss collection
  with separate real PostgreSQL roles, source revisions, retries and deployment
  remain outside these in-process tests.
- Real provider research output, canonical-page verification, artifact retention,
  human usefulness, protected browser article-to-result journey and operations
  acceptance remain unqualified here.
- Full-article extraction, non-RSS source generation, richer reader workflows and
  content/media publishing may justify complementary candidates. Parent's separate
  discovery compares those gaps; they are not reasons to rebuild the working collector.
- Next local consolidation experiment should compare at least RSS/Atom/RDF,
  namespaces, undated baselines, malformed/DTD/entity bodies, missing titles, relative
  URLs, canonical/source-query rules, bytes/item caps, partial errors and unchanged
  story/evidence digests through both adapters. Decide one shared story mapper first;
  retire a legacy parser route only after existing signed plans/receipts have an
  explicit migration or preserved compatibility boundary.
- Public distribution keeps actual imported files and notices. No imported upstream
  backend, settings database or scheduler is needed for the already adopted slices.

Recommendation: **retain and build on current Control Center integration**, compare
new services only for named missing responsibilities, and make duplicate-feed-path
consolidation a bounded later refactor. This reconciliation is not completion of all
F7 candidates or a claim that the live news product is finished.
