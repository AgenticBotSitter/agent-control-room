# F7 reading responsibility partition: independent source check

2026-09-08; checkpoint `17bef80` and proposed responsibility note. Read the complete
note and actual news workspace, wire schema, reading projection, source-reader and
current C3/C4/RC7 scope. No downloads, tests, browser, app edits or Git writes.

## Disposition

No contradiction found in the local source description or blocking omission in this
comparison partition. The note does not select an extractor, reject all full readers,
or declare C3/RC7 complete. Root retains design and final scope decisions.

`private-app/app/news-workspace.tsx:116–122` renders the canonical URL as an external
tab link with `noopener noreferrer`, the summary as React text, and research/archive
controls. `newsPageSchema` limits summary to 4,000 characters and carries source/story
identity; it does not expose an extracted article-body field. `news-reading-view.ts`
translates to borrowed fresh/history/archive/sort functions and maps results back by
story ID; it neither retrieves nor extracts article prose. The source-reader's sitemap
path creates a summary saying a new page was detected. Those claims match actual code.

Existing summary/source-link reading is a real baseline, not proof of rich in-app
article reading. Calling extraction a separable enhancement does not authorize removal
of the desired article-to-research/setup-guide/draft experience. That experience remains
explicit under C4 and the joined services; richer reading is separately evaluated in
this note. C3 still lists readable articles, provenance/freshness, saved archive choices,
pagination and configuration/live/browser acceptance. The note must not be used later
to close those outcomes merely because an external link renders.

The candidate partition is fair: pure HTML extraction cost must be compared separately
from a complete reader service, while external-library import needs a concrete existing
reader interoperability use case and a source generator needs an identified missing
publisher. No new service or code copying follows from that map. Retaining current
summary/source link is a legitimate no-new-component alternative, not a blanket rejection
of Readability or Miniflux's internal module.

## Evidence limits and carry-forward

The Miniflux pinned scraper/manifest observations are explicitly root source reads;
this reviewer did not independently retrieve those public files. Their minimal extractor
dependency closure and runtime fit remain unestablished, as the note says. Likewise,
no actual extraction quality, HTML sanitation, network retrieval permission or publisher
license is qualified by this source check.

Preserving article output separately from canonical summary/digest is an appropriate
comparison constraint: don't truncate extracted prose into the existing field and call
that integration complete. Shared actual-code corpus tests should assess omission and
navigation contamination, not merely nonempty output. Final projection/storage/rendering
choice, link normalization and resource limits remain root's implementation decision.
Extraction output is not source truth or a completed reviewed research result.

RC7's remaining restart/uncertainty, viable candidate-interface evaluations and optional
extension dispositions remain visible. No requirement needs to be dropped to conduct
this bounded extraction-versus-reader comparison.
