# ABS reading: distinct responsibilities and comparison boundaries

Local source checkpoint `17bef80`. This clarifies what a candidate would supply;
it is not extraction implementation, a new required service or a final winner.
Independent [source review](f7-reader-responsibilities-review.md) found no blocking
contradiction; C3 and article-to-research/guide/draft requirements remain open.

## Current source, not a README assumption

- `private-app/app/news-workspace.tsx` renders a story title linking to its canonical
  source in a separate browser tab, plus summary, dates and action controls.
- `src/web/v1/news-wire.ts::newsPageSchema` exposes summary up to4,000 characters,
  source URL and story/evidence identity. It has no extracted-article-body field.
- `src/web/v1/news-reading-view.ts` maps canonical records to the already borrowed
  Control Center sorting/fresh/history/archive functions, then restores original
  records by ID. It does not fetch or extract the linked article.
- `src/vendor/control-center/source-reader.ts` discovers feeds/sitemaps and creates
  stories. Sitemap-only stories can have a generated title and discovery summary;
  finding a page does not extract its prose.
- `src/project-adapters/abs-news/v1/control-center-reader.ts` already supplies bounded
  retrieval/authority/cancellation ports around borrowed discovery. Its existence
  does not automatically authorize fetching every linked article or rendering HTML.

Consequently, full-article extraction is a separable enhancement, not proof the
existing collector is broken or a reason to replace it. Summary/source-link reading
already supports selecting an article and proposing research. Rich in-page reading
would require a reviewed data/rendering integration, not simply changing the parser.

## Candidate responsibility map

| Responsibility | Known candidates | Decisive comparison / scope |
| --- | --- | --- |
| Existing discovery, curation, fresh/history/archive | Adopted Control Center and current feed parsers | DR-02 retained; do not rerun closed parser contest |
| Extract article prose from supplied HTML | Mozilla Readability; Miniflux internal readability and optional CSS extraction | Same synthetic HTML/baseURL corpus, actual implementations, output quality, failure/limits and embedding cost; no fetch/network during extraction |
| Import an already-used external reader library | Miniflux API; FreshRSS Google Reader API | Only adopt for a concrete reader-library interoperability need. Mapping paging/read/star/source identity is not task approval or replacement ownership |
| Add a publisher without RSS/Atom/sitemap | RSSHub selected route; existing discovery where supported | Name an actual missing source, execute selected generator on synthetic upstream, then serialized output through existing intake; no whole route platform copied just for caching |
| Source-bound research and reviewed revision | Existing CR task/evidence/artifact/review services | Reuse joined journey evidence; restart/uncertainty remains, independent of which reader produces an item |

No candidate is rejected merely for language, stars, or README impressions. Full
reader services and their pure extraction modules must be assessed separately:
service overhead is not an honest estimate of the cost of a small extraction helper.
Neither is importing an internal module cost-free or necessarily a supported API.

## New Miniflux source distinction

Re-read pinned `a84533db6ca0a2ff9a47800fbf0326be6d9b3170` scraper and go.mod.
`ScrapeWebsite` fetches with charset/body handling, decides custom rules after a
same-site redirect check, then calls **its own**
`internal/reader/readability.ExtractContent(io.Reader)` as fallback. It does not
declare a standalone external go-readability package. That pure module and its
tests need inspection before concluding that reuse requires the entire reader.
The service's Go1.26/goquery1.12 dependencies are an initial inventory, not yet a
minimal extractor dependency graph or measured runtime requirement.

Sources read through bounded public raw-source requests after web-cache misses:
[scraper](https://github.com/miniflux/v2/blob/a84533db6ca0a2ff9a47800fbf0326be6d9b3170/internal/reader/scraper/scraper.go),
[module manifest](https://github.com/miniflux/v2/blob/a84533db6ca0a2ff9a47800fbf0326be6d9b3170/go.mod).
No files were retained by this root read, no downloaded code executed.

## Fit and migration constraints to carry forward

Do not overwrite canonical story summaries/digests with truncated extractor output
to force it through the existing4,000-character field. Compare preserving article
output as separately bound evidence/artifact versus a versioned optional reading
projection; root must decide the existing integration seam after actual output tests.
An extractor's HTML output is not automatically safe rendering, authenticated source
truth, publication permission or a completed research result. Plain text can be
compared first without pretending HTML sanitization has been qualified.

The shared corpus must include substantial article paragraphs, navigation-heavy
pages, no article, relative links/base tags, hostile markup and large inputs.
Record extraction omission/contamination and limits rather than counting non-null
output as success. Preserve identical inputs and expected content markers across
contenders; DOM/runtime differences belong in adaptation cost, not hidden fixture
changes. Retain current summary/source link as the real no-new-component alternative.
