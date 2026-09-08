# F7 focused additional candidate discovery — source screening

2026-09-08, baseline29dbc4a. This is additional E1 screening, **not equivalent
executed comparison or a final winner**. Existing adopted Control Center and both
installed feed parsers are evaluated separately in the F7 reconciliation.

## Why these candidates

Focused discovery queried public GitHub for Miniflux parsing/reading/scheduling,
FreshRSS article/API support and RSSHub feed-generation routes. Search snippets
were discovery only; primary pinned implementation below controls conclusions.
The uncovered responsibilities are optional richer article extraction, importing
an existing feed-reader library and generating feeds where publishers lack RSS.
These are not reasons to replace the already integrated ABS task/review workflow.

The surveyed set is explicit, not a claim to cover every feed reader. Mozilla
Readability (direct JS library) is a further relevant extraction-only candidate if
full article extraction is selected; its actual source/fit is not evaluated here.

## Actual source findings

### Miniflux — full reader/API and extraction

Pin [a84533db6ca0a2ff9a47800fbf0326be6d9b3170](https://github.com/miniflux/v2/tree/a84533db6ca0a2ff9a47800fbf0326be6d9b3170).
Root Apache-2.0 and file SPDX checked; not a dependency-wide license clearance.

- `internal/api/entry_handlers.go::findEntries` validates status/order/direction,
  paging and feed/category ownership against authenticated user ID before querying.
  A consumer must map entry/feed IDs to Control Room source/story identities, not
  replace canonical project or task IDs with reader IDs.
- `fetchContentHandler` retrieves entry/user/feed under that user; calls the entry
  webpage processor; `update_content` defaults false but true writes extracted title
  and content back. Calling content retrieval is still an outbound fetch, not merely
  a passive database read. Treat provider/retrieval authority separately from login.
- `internal/reader/scraper/scraper.go::ScrapeWebsite` uses the project's request
  builder, charset reader and configured body limit. It chooses same-site CSS rules
  or readability after redirects, with absolute `<base>` handling. Selected scraper
  tests exercise custom selectors and base URL behavior; inspected, not executed.
- Sanitizer source has explicit element/attribute policies; extraction alone is not
  sanitizer acceptance. Do not copy scraper output into unsafe HTML rendering.
- `go.mod` requires Go1.26 and goquery, networking/text, SQL and other dependencies.
  Go is absent on this host. No toolchain, binary or database was installed/run.

**Fit:** strong viable separate-reader/API option if ABS needs a managed subscriber
library and richer retrieval, or potential narrow Go extraction helper. Not a
TypeScript drop-in. Separate feed state is permissible as source cache, not another
global job authority. Need actual API/fixture/identity/duplicate and resource tests
before choosing it over existing Control Center. No runtime cost measured and no
code deletion earned by this inspection.

### FreshRSS — existing reader interoperability

Pin [65e402ca412dd2683ed3b36ac673cb7cdf5de43e](https://github.com/FreshRSS/FreshRSS/tree/65e402ca412dd2683ed3b36ac673cb7cdf5de43e).
Root AGPLv3 inspected. Do not copy this source into an Apache-only distribution
without resolving the combined distribution obligations. Separate service integration
is a distinct evaluation, not a claim that licenses cease to matter.

- `p/api/greader.php` implements the actual Google Reader endpoint handlers,
  authorization, stream item/contents and edit-tag behavior. It is executable PHP
  application code coupled to FreshRSS user configuration/DAO, not a standalone
  Node client or a replacement for Access assertion validation.
- `app/Models/Feed.php::load` initializes `FreshRSS_SimplePieCustom`, supports cache
  bypass/hash checks and configured HTTP options; `loadGuids`/`decideEntryGuid`
  manage entry identities. `loadJson` and `loadHtmlXpath` are implemented alternate
  input routes, not just README promises.
- Authentication and read/star state belong to FreshRSS. A bridge needs its own
  narrow credential handling and must not equate read/star with reviewed/verified
  Control Room evidence. PHP is absent; no full parser or API was run.

**Fit:** credible interoperability source for someone already operating FreshRSS;
full replacement adds a PHP application and reader state. Direct source adaptation
is not presently selected under the project's distribution policy. Native service
API behavior, paging/duplicates and extraction quality remain untested, not failed.

### RSSHub — feed generation, not another ABS coordinator

Pin [865f1cf5af3973dffaa2cb8c2d73ee0538043c12](https://github.com/DIYgod/RSSHub/tree/865f1cf5af3973dffaa2cb8c2d73ee0538043c12).
**Current pinned LICENSE and package manifest say AGPL-3.0**, despite an older
search snippet calling it MIT. No source copied into Control Room; actual selected
pin, not an old reputation, must drive redistribution review.

- `lib/routes/github/issue.ts` calls GitHub's issues API with optional configured
  token, filters pull requests and emits normalized feed items. Markdown rendering
  enables raw HTML. This handler does not make its returned descriptions trusted
  HTML; keep the existing reader sanitization and source provenance boundaries.
- `lib/utils/rss-parser.ts` is a small wrapper around `rss-parser`, adding a magnet
  field and configured user agent. The package declares rss-parser3.13.0, **plus a
  patch and dependency overrides**. It is not valid to call that identical to our
  installed3.13.0 behavior without inspecting/executing the patch scope.
- `lib/middleware/cache.ts` uses an atomic-claim-capable backend to coordinate
  cache misses, bounded waiting, TTL and finally release. Non-atomic backends skip
  fetch claims. This is feed-cache coordination, not durable task ownership, effect
  reconciliation or a replacement for pg-boss. Upstream cache/parser tests inspected,
  not run. Their route dependencies/config are not installed here.
- Node engines are22.22.2/24.15.0 ranges at this pin; runtime and build have many
  dependencies, including Redis and browser-related tooling for relevant routes.
  Do not infer every route starts a browser, nor that the full service is lightweight.

**Fit:** complementary feed producer for a specifically needed non-RSS source.
Prefer a separate explicit source endpoint through the existing bounded feed intake,
not copying route engines/caching into the web app. Exact route license, credentials,
fetch targets, content policy and disposable generated-feed-to-intake tests remain.

## Shared comparison card before any choice

For reader imports: one synthetic feed/article corpus, canonical URL/GUID collisions,
missing title/date, relative links, HTML/script content, paging and repeated import;
then materialize one ordinary research task and retain original source evidence.
Test error/disconnect/retry and upstream identity changes, not just a successful GET.
For extraction: compare actual outputs on the same local HTML corpus with existing
reader and direct extraction library; measure output quality, body limits and memory.
For generated feeds: run one actual selected route against a synthetic upstream,
then its actual serialized feed into current intake. A hand-written pretend feed
would prove our parser only, not RSSHub integration.

Count whole-service setup/state/credential updates and rollback against a narrow
adapter. Existing queues, review and verification must remain authoritative.
No winner, unsupported numerical scores, performance claims or production deletion
is recorded here. This screening adds alternatives and exact tests, not another
implementation engine or an excuse to delay the already-working collection path.

See [source receipt](f7-candidates-source-receipt.json) and
[acquisition ledger](f7-candidate-acquisitions.md). No external requests were made
by downloaded candidate code; only public source acquisition occurred.
