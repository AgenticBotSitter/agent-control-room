# RC7 reader services and generated-source dispositions

2026-09-08; Control Room baseline17bef80, branch `codex/idea-abs-workflows`.
Independent bounded source assessment; root owns final disposition.

**Keep the borrowed collector for its proven collection responsibility.** Miniflux
and FreshRSS supply real reader-library services that it does not implement;
RSSHub supplies source-specific feed generation. No concrete required publisher or
existing external reader library has been identified in the reviewed C3/C4/C5
outcomes. That supports conditional interoperability/generation work, **not** a
claim that rich reading or all of C3/C4 is finished.

## Evidence actually used

Existing `f7-candidates.md`, `f7-candidates-source-receipt.json`, acquisition ledger,
`f7-reader-responsibilities.md`, current source-reader and its bounded CR wrapper,
outcome map and comparison program were reviewed. The old source root was already
cleaned. This pass re-read three public immutable source files into memory and
checked their full SHA256 against the existing receipt before focused inspection:

| Candidate pin | Exact implementation | Verified SHA256 |
|---|---|---|
| Miniflux `a84533db6ca0a2ff9a47800fbf0326be6d9b3170` | `internal/api/entry_handlers.go` | `fa1a12381ddd6dd98812756a46065c5fe1624aefeff9a6d200d57aa6fce6fbf5` |
| FreshRSS `65e402ca412dd2683ed3b36ac673cb7cdf5de43e` | `p/api/greader.php` | `4ca63d62f1dd6c98afb1bd4ccb89d13f94a2302abe7b186d9f60b8c75c74ce42` |
| RSSHub `865f1cf5af3973dffaa2cb8c2d73ee0538043c12` | `lib/routes/github/issue.ts` | `8c4c4b0bc394f559dd33e57955ba9f913411f22f58de38accace0fdb7a24b4d9` |

Additional focused reads of the same functions used the same immutable URLs; no
candidate code ran and no downloads were retained. Requests had15-second deadlines.
No new disk footprint, install, credentials, provider calls, services or GitHub writes.
These service/interface conclusions are **E1**, not E2. Miniflux's separate pure
extractor has E2 evidence in `f7-miniflux-extractor-fit.md`; that does not qualify its
API, scheduler, authentication, database or webpage retrieval.

## What the current collector actually supplies

`src/vendor/control-center/source-reader.ts::createIndustrySourceReader` takes an
explicit `readText` and clock port. `readSource(source, previousSnapshot)` reads a
direct feed, discovers linked/standard RSS/Atom endpoints, then tries declared and
standard sitemaps. It returns `IndustryReadResult`: source URL, normalized LiveStory
items, status, coverage completeness and optional feed/sitemap snapshot. Feed
results baseline undated entries; sitemap results compare prior URLs and can retain
partial-coverage status. A sitemap story's title is URL-derived and its summary
only says that a page was discovered: it is **not extracted article prose**.

`src/project-adapters/abs-news/v1/control-center-reader.ts::createControlCenterCollectionReader`
wraps that port with current source authority, allowed endpoint schema, public-address
DNS checks, cancellation/deadline, attempt and reserved-body budgets. An existing
reader's private authenticated API is not an ordinary uncredentialed public-feed
URL and must not be smuggled into this port by weakening those checks.

`src/web/v1/news-wire.ts` and the news workspace currently project summary plus
canonical source link, not a rich article body. Importing a service's arbitrary HTML
into the summary field would not complete the reading requirement. Existing CR
source/story/digest/task/review identity stays authoritative whichever intake is used.

## Candidate-specific mappings and dispositions

### Miniflux: viable managed-reader alternative, optional library bridge

`findEntries` validates filters/order, checks feed/category membership for the
authenticated user, then applies limit/offset on the user-scoped query builder.
`getEntryFromBuilder` returns an entry with media-proxy rewriting. This solves
managed subscription/library querying and reader-level state, not task execution.
`fetchContentHandler` loads user-owned entry/feed and calls
`processor.ProcessEntryWebPage`; its `update_content` flag defaults false but true
writes title/content. Even false is an outbound webpage retrieval, not a passive
library read. Those effects need their own accepted boundary.

A minimal bridge would read selected pages/entries, retain external service+user+
entry/feed identity as provenance, and translate URL/title/date/content into CR
story intake without substituting reader IDs for CR IDs. Pagination checkpoints,
duplicate URLs, edited entries and read/star state require explicit reconciliation.
The service can be a source cache alongside the one CR work authority; there is no
reason to import its database or queue ownership into CR.

**Disposition proposal:** defer the full API bridge unless an actual Miniflux library
must be imported/synchronized, or root deliberately chooses a managed reader as
the richer-reading implementation. Keep the narrow pure-extractor option separately
compared to Mozilla; no full service is necessary for extraction alone. Strong
alternative to new reader-library infrastructure, not rejected for being Go or large.
Current deletable production code:0. Costs not yet measured: service setup, private
client/auth, state reconciliation, upgrades, backup and API failure handling.

### FreshRSS: viable existing-library interoperability, not a standalone parser

`greader.php::streamContents` maps stream types to DAO queries and pagination.
Continuation requests increment the count, discard the overlapping first item and
emit the last FreshRSS ID when another page may exist. `entriesToArray` consults
categories/tags, invokes an entry-before-display extension hook and delegates to
`FreshRSS_Entry::toGReader`. `streamContentsItems` accepts Google-style item IDs and
normalizes them before the DAO lookup. Thus direct copying of one handler still
requires substantial FreshRSS application state; this is not a pure JSON transformer.

Use the supported service API as a separate bridge if needed: external stream/item
and continuation identity → separately tracked import cursor/provenance → CR story
intake. Reader tags/read/star choices are not accepted CR research or reviews.
Returned content still needs CR's reading/evidence handling. No copied PHP controller
or replacement for Access validation is justified by this interface inspection.

**Disposition proposal:** conditional existing FreshRSS-library interoperability or
an explicitly selected managed-reader experience. Keep current collector or use a
small API client rather than implement a second reader service ourselves. Exact pin
is AGPLv3; separate-service use still requires license/deployment review, not an
assumption that obligations disappear. Current deletion:0; API/DAO runtime,
pagination under concurrent updates and import fidelity remain unexecuted.

### RSSHub: a specific missing-source adapter, not a universal news requirement

The only selected concrete route is GitHub issues. Its handler takes user/repo/
state/labels, calls GitHub's issues API using configured optional token, filters out
pull requests and maps issue title/body/created date/author/link into feed items.
Markdown is rendered with raw HTML enabled. This is actual source-specific
generation, but the handler's returned object is not yet the service's serialized
RSS response. Route, serializer and current intake need a joined test before claiming
integration. Cache/parser snippets previously inspected do not prove that journey.

The current reader can consume a permitted generated RSS endpoint directly, retaining
original item URLs as story provenance. Its existing authority/public-address checks
remain; privately hosted RSSHub would need a reviewed separate boundary rather than
an unchecked localhost exception. There is no evidence that GitHub issues are a
required ABS publisher, and this report does not invent one.

**Disposition proposal:** defer until a named desired source has no acceptable
RSS/Atom/sitemap coverage and an actual supported route fills that gap. Also compare
the publisher's own feed/API and a minimal source adapter at that point. Do not adopt
the whole route platform just for caching. Pinned RSSHub is AGPL3, not its historical
MIT reputation. Current deletion:0; no source-generation service selected now.

## Outcomes retained, gates and concrete reopening tests

| Outcome | What remains required | Candidate trigger and acceptance |
|---|---|---|
| C3 collection and reading | Approved real feeds, provenance/freshness, pagination, saved archive across repeated collection, and a readable article experience. Rich in-page reading is not erased by the existing summary/link UI. | Root must carry a concrete richer-reading implementation and acceptance in the plan. For pure extraction, use existing same-corpus E2 comparison then a joined data/rendering test. For a managed reader selection or existing library, execute its actual API with disposable entries, pagination overlap/concurrent changes, missing/changed IDs, HTML/relative links, repeats, auth failures/disconnects and bounded recovery through CR intake. |
| C4 article → research/guide/draft | Same source/digest must produce ordinary task, real sourced result and review; existing verification-first and setup/editorial gates remain. | Any imported/generated article must traverse that existing journey, preserving source URL and external provenance. Neither read/star nor fetched HTML substitutes for verification; neither API offers agent/review authority. Existing synthetic joined evidence is useful but no new live acceptance claimed. |
| C5 generic content/media and harness packs | Keep separately scoped later work, public examples and capability-specific acceptance; no automatic publish/media authority. | A named content source, reader library or publisher-specific requirement can reopen the relevant candidate. These services do not themselves supply generic project/harness integration. |

There is no identified *reader-library-specific* requirement forcing an actual API
service experiment now. Conversely, rich reading remains a decision-changing local
integration seam: the pure-extractor runs alone do not prove the protected UI,
article/body evidence binding, sanitized rendering or fetch policy. If root selects
a full reader service to satisfy that seam, its actual API test is necessary before
selection closure; it cannot stay E1 under an "optional interoperability" label.

Comparative judgment only (0–5, higher better): current collector for existing
discovery fit4–5 and migration ease5; minimal managed-reader API bridge for an
existing library fit3–4, effort unknown until execution; RSSHub for the currently
unnamed missing publisher fit **unknown**, not0. Maintenance/resources unknown for
unrun services; no weighted winner. This report disposes specific optional candidate
responsibilities provisionally and preserves the remaining required C3/C4 work.
