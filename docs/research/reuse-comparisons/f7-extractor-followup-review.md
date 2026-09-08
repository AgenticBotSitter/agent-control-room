# Extractor follow-up independent review

2026-09-08; local baseline `17bef80` plus research packets. Reviewed both fit reports,
actual authored harnesses/Go runner and saved execution/acquisition information. Parsed
receipts locally; no candidate rerun, download, service, application or Git change.
Upstream downloads are cleaned, so their source/license inspections and cleanup remain
recorded author evidence rather than independently repeated observations.

## Disposition

No blocking contradiction for retaining these E2 comparisons. Neither is full
application fit or final adoption. The reports fairly separate pure Miniflux extraction
from its service and the bundled Mozilla parser from a general-purpose DOM.

### Corpus and executed results

The jsdom, bundled-parser, heuristic and Miniflux receipts have the same corpus hash.
Bundled baseline harness asserts that hash against the preceding jsdom receipt;
Miniflux asserts its literal hash before running. Comparing saved baseline rows confirms
equal disposition/title/textContent/content/expectedMatched values, including the
navigation-only false positive and caller-gated oversized row. Six shared inputs are
not six successful extractions, and no malformed-page/general DOM equivalence follows.

The optional actual readability heuristic is a separate experiment: all five parsed
inputs produce `doc.querySelectorAll is not a function`; the byte-gated input is skipped.
Those are interface failures, not five “unreadable” classifications. No compatibility
shim was inserted and baseline extraction was not retroactively changed.

Miniflux receipt records seven successful subprocess exits and 230 named upstream Go
test pass events; benchmarks did not run. Authored runner passes exact original HTML
to unchanged `ExtractContent` and records native base/content/error output. It does not
feed the corpus baseURL or max-element option into an invented interface, compute a
fabricated title, or normalize empty output into a null article. Relative URLs, empty
wrapper output and navigation content therefore remain honest differences. The six
cases are recorded outputs, not assertions that every shared expectation passed.

### Actual interface, embedding and resources

Miniflux does not require its full service/database, but Node integration still needs
a bounded process adapter, packaging and metadata/link/empty-content handling. Mozilla
provides richer metadata/URL behavior here. Its bundled parser removes jsdom's runtime
closure in this experiment, but lacks the heuristic's selectors and forgiving HTML5
behavior. Neither finding justifies building a replacement DOM/selector engine merely
to keep a smaller package count. Current summary/source-link UI remains a valid baseline.

Both preserve event-handler HTML and are not sanitizers. Synthetic script markers and
source-described absence of fetch/eval are narrow evidence, not hostile-code isolation
certification. Neither harness integrates retrieval, canonical story evidence, article
storage or rendering into Control Room. Existing collector/task/review authority earns
no deletion from this work.

Miniflux's four external imported packages differ from its broader downloaded module
graph; import of net/http is not proof an HTTP request executed. Its total toolchain/
cache disk cost is not deployed-binary memory. Mozilla's separate process RSS difference
is useful bounded observation, not production throughput or randomized performance proof.
Both reports preserve unknown startup/worst-case/page-quality costs.

### Licenses and acquisition caveats

Bundled JSDOMParser's recorded MPL-2.0 file header must not be flattened into the package
Apache metadata. Exact redistribution/source obligations remain a shipping decision;
neither automatic whole-project relicensing nor automatic clearance is established.
Miniflux Apache and selected BSD-style dependency texts likewise do not clear the full
distributed toolchain/dependency scope. No legal or final shipping acceptance here.

The Miniflux reproduction script's full-buffer fetch lacks an acquisition deadline and
enforces size only after buffering; it also assigns HOME. These are explicitly disclosed
procedure defects, not safe patterns to reuse. Do not rerun that acquisition unchanged.
They do not fabricate the successful compiled extraction evidence. Cleanup's initial
read-only-cache removal failure and owned-only permission correction are retained;
final root absence is author-recorded, not observed by this review. No resource cleanup
failure is hidden by describing the initial removal as successful.

Final choice still needs meaningful HTML compatibility/quality and concrete application
adapter cost assessment. These source-and-runtime comparisons are strong enough to
inform that next bounded work without another unchanged rerun or a premature winner.
