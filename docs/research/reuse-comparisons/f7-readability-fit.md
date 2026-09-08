# RC7 Mozilla Readability extraction-only fit

2026-09-08; baseline `17bef80`. **Actual Readability0.6.0 extracted the main text/title and resolved relative links on this small synthetic corpus. It also returned an article for navigation-only input and retained an event-handler HTML attribute. It is not a sanitizer or a replacement for the existing ABS collector.** No winner selected; Miniflux extraction and other reader/feed-generator responsibilities remain separate comparisons.

## Actual source and pin

Registry `@mozilla/readability@0.6.0`, gitHead `4d5dd0bbe0bfbc44e219dc86865131e79639e30b`, Apache-2.0, Node>=14. Actual `Readability.js` SHA256 `34dcab3d0832d0019f02990eed6b6124e029e8c32b9f0c6f2550544ff8dff174` enforced before execution. Public `new Readability(document,options).parse()` operates on and mutates a DOM; no own HTTP fetch or database. `_grabArticle` scores/prunes content; `parse` at2723 checks optional element count, extracts JSON-LD, removes scripts, prepares/scans content, returns null or title/content/textContent/excerpt/byline metadata. `_fixRelativeUris` at456 uses document baseURI to resolve links/media and removes recognized javascript links. None of this establishes safe HTML rendering.

Actual DOM is `jsdom@26.1.0`, MIT, Node>=18; API SHA256 `0653e655065e93d44d885b04a975c0bac3221513bfc7be0be0afd2a4cc99ff2e` enforced before import. API `resourcesToResourceLoader` supports an explicit ResourceLoader and default no-op; runScripts is absent by default. Fixture supplies a loader returning null for every requested resource and never delegates to HTTP. It deliberately does not enable runScripts or use fromURL. Network classes existing in jsdom's dependency closure are not evidence of network execution. Actual test observes1 resource-loader attempt for iframe, blocked locally, scripts never execute. DOM window is closed in finally for each terminal parsed case.

Pinned upstream `test/test-readability.js` was read completely and its hash retained (`997d0e031048819c9ff150f61474f9e02378f1cb2f414f5dc2efb1c7a95ca284`). It exercises expected DOM/text/title/byline/excerpt/site metadata across fixtures using jsdom and built-in JSDOMParser, constructor options, max-element rejection, serializer and allowed-video behavior. These upstream tests were **inspected, not executed**; the full website corpus was not downloaded. Actual authored corpus below is runtime evidence. The built-in DOM parser is an untested lighter alternative to jsdom, not assumed equivalent.

## Shared expected corpus and direct results

`research/reuse-comparisons/f7-extraction-corpus.json` is original synthetic data shared with the separate Miniflux comparison: source HTML, base URL and expected markers/optional capabilities. Decoded quotes were explicitly checked: no literal escaped-backslash quote in any of the6 inputs. That was a display concern, not a fixture or library failure; corpus unchanged.

| Scenario | Actual result |
| --- | --- |
| Article + relative guide link | Expected title/main markers; guide resolves to `https://example.invalid/guide` |
| Main article with navigation, scripts, iframe and onclick | Main markers retained; nav/footer noise removed; no script tag in output; no script execution. **onclick attribute remains** |
| Empty document | null / no article |
| Navigation-only document | **Article returned**; expected no-article classification fails, preserved |
| Oversized byte input | Caller research byte gate rejects before DOM construction; **extractor not executed** |
| Oversized element count | Actual extractor option rejects with element-count error, after DOM construction |

5/6 expected classifications matched, not6passes. Capture keeps actual HTML and text for independent inspection. Inputs/outputs are synthetic, not publisher articles. A title field or resolved link is an extractor capability, not mandatory for every possible main-text-only competitor. The local byte gate is fixture policy, not a built-in Readability body limit; element count does not bound memory already consumed by DOM parsing.

First attempt deliberately threw from the denying ResourceLoader; jsdom synchronously requested the iframe and the authored fixture stopped. One focused fixture repair returned null (supported no-load result), without ever delegating a fetch. Same corpus then completed. Initial error and final direct output retained in `f7-readability-evidence.json`. A later evidence-save orchestration typo referenced an unavailable variable; saved the same completed output afterward without a third extractor execution. No product failure hidden or expected result rewritten.

## Control Room boundary and integration cost

Current `src/web/v1/news-reading-view.ts` maps title/summary/canonicalURL into adopted Control Center presentation, then selects/sorts existing stories; no article fetch or extraction occurs there. `src/vendor/control-center/source-reader.ts` uses injected bounded readText, feed/sitemap parsing and stable evidence/identity construction. Existing summaries/source links are not deficient merely because a full-article extractor exists. Readability would be an optional separately authorized page-body enrichment after retrieval, not replace feed discovery, history/archive, story identity, curation, research jobs, review or canonical evidence.

Possible seam: bounded retrieved HTML plus approved final/base URL → inert DOM → actual extractor → untrusted extracted text/content metadata. Prefer text-only presentation unless root selects and validates a separate maintained sanitizer/rendering boundary. Keep original source URL and extraction provenance; no retrieved page authority over tasks. Root owns SSRF/redirect/URL policy, budgets, persistence/copyright scope and HTML presentation. This packet neither designs nor changes those policies.

No upstream fork or new service needed for a JS extraction path. Costs: one extractor package plus a DOM implementation (40 installed packages total in this tested closure), input/output bounds, extraction quality/no-article fallback, attribution/provenance and caller glue. Zero current product files earned deletion: avoid a future custom extraction algorithm if this candidate wins, retain current collector/view. A built-in parser variant might reduce dependency cost but was not executed. Keeping existing summaries alone has no new extraction cost and remains viable until full reading is selected. Miniflux pure extraction, full Miniflux/FreshRSS reader interop, and RSSHub generated feeds must not be conflated.

Scope E2 actual extraction on synthetic corpus, **not E3 integrated full-article workflow**. Root comparison may combine this evidence with its real source/story boundary; this author does not declare that done. Suggested judgments0–5: feature fit3–4 (main content and metadata good here, nav false-positive), adaptation effort3 (no service, DOM/security glue required), custom avoided4 (real extraction algorithm), maintenance3–4 (pinned project with inspected tests, update assessment pending), comparative resources unknown. Do not rank against Miniflux until same workload results and whole-process costs are available.

## Licensing, resources and cleanup

Readability LICENSE.md contains Arc90 copyright and Apache2 notice/link; jsdom LICENSE.txt is MIT and read. Lock metadata across all40 installed packages includes MIT/MIT-0/Apache/BSD/ISC. Full closure URLs/integrities retained in `f7-readability-acquisitions.json`; root licenses are not complete transitive text clearance. No third-party source imported into app or article publication authorized. If shipped, exact extracted dependency notices/source-modification scope must enter F9.

Node whole-process maxRSS113520KiB for this small sequential fixture includes jsdom/imports; not production memory or extractor-only RSS. Per-case elapsed values are diagnostics, no warmed benchmark. Owned install/cache30MiB plus separate metadata cache44KiB; initial139GiB free and other scoped cohorts227004KiB. Installation scripts/audit disabled;40 packages, whatwg-encoding deprecation warned. Both exact owned roots removed after receipts; absence checks succeeded. No live handles/services. Research corpus/evidence remain; downloads removed. No GitHub/Git/app changes.
