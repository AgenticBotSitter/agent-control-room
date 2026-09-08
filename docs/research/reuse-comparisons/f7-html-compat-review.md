# HTML compatibility independent review

2026-09-08. Read complete fit report/harness, inspected corpus expectations and parsed
saved receipt. No rerun, download, application edit or winner selection.

No blocking contradiction found. Both actual DOM choices receive identical HTML and
base URL from the same corpus entry, followed by the same Readability implementation
and element limit. There is no pre-normalization, custom selector or intentional input
damage applied to only one candidate. These are reasonable discriminating raw-HTML
requirements, not a fabricated scoring failure.

Receipt records ten normal subprocess exits but only five matched outputs—all jsdom.
Three bundled-parser cases return an invalid/incomplete document and produce the
actual Readability constructor error; two produce content but miss expected base-link
or decoded-entity semantics. Parent retains process status separately from output error
and expectedMatched, so exit 0 is not mislabeled successful extraction.

The base case supplies a standard void `<base href>` and expects `/docs/guide`, not
the document URL's `/news/guide`. The entity case requires the exact decoded marker
`ENTITY_MARKER © é — 😀 & End.` in text. Ordinary cases require CORE_A/CORE_B plus
the expected resolved guide. Those criteria genuinely distinguish observed behavior,
though substring matching is not exact full-text or DOM equivalence and an expected
URL anywhere in content is weaker than asserting a particular anchor attribute.

The optional heuristic really calls exported `isProbablyReaderable` on jsdom documents
for the two old corpus entries and records true/false. It does not rerun old extraction
or substitute custom classification. These outcomes are recorded observations rather
than asserted expected booleans; no broad accuracy or false-negative guarantee follows.
The report states this limitation. It fairly contrasts the earlier bundled DOM's
missing-selector error with actual compatible-DOM execution.

Selected source files are hash-checked. New corpus digest is recorded rather than
independently pinned in each child; unchanged local files during the run are assumed.
Separate children have bounded timeout/output and explicit small environment, not
an OS sandbox or memory cap. Scripts stay disabled and resource callbacks do not
delegate network requests. No proof of sanitized output, real-publisher quality,
runtime authorization, source retrieval or Control Room storage integration follows.

Resource comparison appropriately admits early failure in three bundled cases and
cold single executions. Smaller RSS/faster failure cannot outweigh unmet semantics
by arithmetic alone. MPL/subpath/API caveats and jsdom's dependency costs remain real.
Acquisition cleanup/license inspection are author-recorded; upstream files were not
reacquired by this review. No full redistribution clearance is implied.

This packet justifies declining bundled JSDOMParser as an equivalent raw publisher
HTML DOM on the tested requirements, without alleging a library vulnerability or
discarding specialized well-formed-markup use. It does not justify building a custom
normalizer/entity/selector system or proclaiming jsdom the only possible solution.
Root can combine these findings with prior Miniflux extraction and actual integration
cost; final direction and E3 application acceptance remain separate.
