# Miniflux's internal extractor: minimum reusable scope

2026-09-08; Miniflux pin `a84533db6ca0a2ff9a47800fbf0326be6d9b3170`.
**E1 source inspection only.** No Go toolchain, dependency installation, candidate
execution, service, database or application change. This is not external
go-readability: the actual scraper imports Miniflux's own internal reader package.

## Concrete boundary

`internal/reader/readability/readability.go` is10,958bytes of actual extraction code.
Its public function is `ExtractContent(io.Reader) (baseURL string, extractedContent
string, err error)`. It constructs a goquery DOM from supplied bytes, reads the first
absolute HTTP(S) head/base URL using `internal/urllib.IsAbsoluteURL`, removes script/
style elements and unlikely class/id candidates, preserves candidates inside code
blocks, scores content length/commas/class names and link density, then serializes
the best candidate with relevant siblings as an HTML fragment.

Only one internal helper package is imported: `internal/urllib/url.go` (6054bytes).
That file is stdlib-only; the extractor calls only IsAbsoluteURL, which uses its
hasHTTPPrefix helper and net/url. Preserving both actual files unchanged avoids
inventing URL semantics. Their `internal` paths require a runner under a
`miniflux.app/v2` module tree; an unrelated external module cannot import them
directly. A disposable same-module runner can test this without a Miniflux server.

Direct external package imports are goquery and x/net/html. Miniflux pins
goquery1.12.0, x/net0.58.0 and indirect cascadia1.3.3. Inspected goquery1.12.0 go.mod
declares cascadia1.3.3 and x/net0.52.0, Go1.25.0; the Miniflux root raises x/net to
0.58.0 and declares Go1.26.0. Use that existing upstream1.26 baseline for an exact
experiment rather than claiming a lower toolchain works without checking it. The
minimal selected package graph still needs `go list -deps` confirmation once a
toolchain is authorized; this is not a compiled or runtime-measured closure.

The reusable path needs no SQL, feed subscriptions, API auth, scheduler, HTTP
fetcher or web UI. In contrast, `scraper.ScrapeWebsite` is the larger retrieval
boundary: fetcher/config, content-type/body/charset handling, redirects, domain-
specific selectors and effective URL fallback. Do not import that whole service
merely to call the pure extractor, nor label its additional fetch safeguards as
features of ExtractContent itself.

## Native behavior versus required wrapper

This interface returns HTML/base URL only: no article-title field, text-only output,
extraction-confidence/no-article Boolean, configured maximum elements or cancellation
parameter. It does not resolve relative links against the request URL. If no candidate
scores, it falls back to body and can serialize an empty wrapper or nonarticle body.
No executed claim is made about which shared fixture triggers that fallback.

Byte limits belong before DOM parsing; an io.Reader size policy can be shared with
Mozilla's caller gate. Element limits and no-article classification are not native
options here and must be recorded as absent/unproven, not fabricated as passes.
Title extraction and URL resolution would be explicit additional mapping work.
Removing script/style is not sanitization: getArticle serializes selected innerHTML
without a comprehensive attribute/URL policy. No downloaded HTML executes in this
source-only inspection, and the pure Go path has no JS interpreter or fetch call.
That does not make its output safe to inject into the browser.

Current Control Room reading provides summaries plus a canonical link, and news-wire
has no approved full-body field. This candidate addresses an optional extraction
responsibility, not a missing replacement for the existing collector or research
task coordinator. Adding article display requires a separately selected safe-output
boundary; the present work does not define that security policy.

## Upstream tests and shared execution proposal

Inspected `readability_test.go` (76,536bytes) includes inline tests for absolute/
relative/multiple base, script/style removal, ad-class removal, nested code spans,
candidate weights, parent/sibling scoring, paragraph/link-density thresholds, empty
selections, misused divs, sentence detection and a broken io.Reader. Those test
functions can execute without full app infrastructure. None ran in this work.

The32byte `readability/testdata` content is a symlink target
`../../reader/sanitizer/testdata/`, not fixture HTML. The benchmarks require
miniflux_github.html/miniflux_wikipedia.html through that link. Do not mistake the
downloaded pointer bytes for hydrated testdata or claim benchmark coverage. The
inline unit tests can be selected without benchmarks or downloaded publisher pages.

Operations supplied shared `research/reuse-comparisons/f7-extraction-corpus.json`:
article/relative-link/main-text, nav+scripts, empty, nav-only, byte refusal and element
limit. Use those exact six inputs for later execution. First call the actual pure
function unchanged and retain raw baseURL/HTML/error. Independently compute comparable
text markers for inspection, keeping raw output and distinguishing native title/URL/
limit omissions from wrapper behavior. Compare empty/navigation outcomes without
editing expectations to favor either library. Add the existing inline broken-reader
test for its native error seam, not a fake transport error. Mozilla's own measured
results are separately reported by operations; they are not Miniflux evidence.

## Cost, licensing and next decision

Actual minimum vendored-source option: two Apache-2.0 files totaling17,012bytes plus
existing Go dependency packages and a short same-module stdin/stdout test runner.
Miniflux root license and source SPDX inspected; goquery's retained license is
BSD-3-Clause. x/net/cascadia license closure and compiled dependencies still require
inspection at acquisition. Shipping a derived package needs exact changed-source
notices; a source-only pin is not blanket redistribution clearance.

Compared with Mozilla in Node, this adds Go build/artifact packaging and a process
or embedding boundary. That is a concrete integration cost, **not** a reason to
reject it without testing actual quality/footprint. Compared with full Miniflux, it
avoids reader DB/API/operational state entirely. No existing Control Room module is
deleted by adding optional extraction, and no new generic extractor should be
written before this pure contender has a fair shared-corpus evaluation.

Next: coordinate an explicitly bounded Go1.26 package hydration and isolated runner
with root, after shared-corpus scope is fixed. No toolchain installation is performed
or assumed authorized by this report. Runtime memory, startup, extraction quality,
elapsed time and final selection all remain unknown. This is a viable minimal
contender, not a source-only rejection or an accepted product integration.

## Acquisitions and cleanup

Disk check before acquisition:139GiB free. Public directory metadata was read without
retention. Named source/license/metadata files are listed with URLs and SHA256 in
`f7-miniflux-extractor-acquisitions.json`; aggregate retained bytes are in that receipt.
Owned root `/private/tmp/cr-f7-miniflux-extractor.s3s5gY` stayed below500KB; no dependency
tree or toolchain downloaded. Initial web open returned cache miss; direct pinned
public source retrieval succeeded, with no candidate runtime retries.
Cleanup disposition is appended below; no persistent resources were created.

Follow-up: root authorized the actual isolated Go evaluation. See
`f7-miniflux-extractor-fit.md` and its runtime evidence for230 upstream tests and the
shared six-case outputs. The entire owned root, including subsequent toolchain and
module downloads, was removed and absence verified; the initial read-only module
cache cleanup failure and exact permission correction are recorded there.
