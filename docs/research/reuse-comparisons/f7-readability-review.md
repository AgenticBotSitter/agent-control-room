# Mozilla extraction independent review

2026-09-08. Reviewed complete harness, corpus structure/content, fit report and parsed
direct receipt. No extractor rerun/download, application edit, browser or service.
Downloaded sources were already cleaned; package implementation/license inspection
and exact-root cleanup remain author evidence, not independently repeated here.

## Disposition

No blocking contradiction for this E2 extraction packet. Preserve the negative result
and do not choose a winner before the same-corpus Miniflux comparison. The harness
loads actual pinned Readability/jsdom, not a mocked extraction algorithm, and tests
original synthetic HTML rather than publisher content or existing CR story APIs.

Selected implementation hashes and package versions are checked before extraction;
this is not an exact hash guard on every executed transitive module. Corpus hash is
recorded, not asserted against an immutable expected pin. Cross-candidate comparison
must use that same recorded corpus hash, not silently revised inputs.

The direct receipt matches the reported useful distinctions: main markers/title and
relative link recovered, navigation/footer contamination absent in the article case,
empty input rejected, navigation-only false positive retained, event-handler attribute
retained. Five of six expectation rows match, but only five execute the extractor:
the oversized-byte row is authored admission policy before DOM construction. Thus
“5/6” is a mixed fixture expectation count, not an extractor success rate. Element-limit
rejection is candidate code, after the DOM already exists.

JSDOM has no `runScripts` option enabled. The loader returns null and never calls a
network superclass; the receipt records one local resource callback, not a completed
HTTP request. `EXECUTED` stays undefined and windows close in finally. Those controls
support inert processing of these inputs, not a general hostile-code sandbox. Presence
of an onclick attribute in output positively demonstrates why extraction is not HTML
sanitization; no safe-rendering claim follows from removed script tags. The first
throwing-loader failure and focused null-return correction are transparently retained.

## Important remaining test limits

The corpus is small and repeats long synthetic paragraphs. Marker presence and noise
absence do not measure full-text completeness, order, duplication or quality across
real layouts. Relative-link coverage uses a document URL but no explicit `<base>` tag;
base-tag precedence and conflicting/hostile URL behavior remain untested. No charset,
multilingual, paywall, malformed-layout or real-publisher generalization follows.
The 32KiB-style oversized case is a caller byte gate, not stress evidence or a CPU
deadline. Whole-process RSS/timings include DOM imports and are correctly not production
memory or a comparative benchmark.

Keeping built-in JSDOMParser as an untested lower-dependency alternative is fair; jsdom's
40-package closure is the tested embedding cost, not an unavoidable Readability cost.
Likewise Miniflux's extraction helper must be compared separately from its whole service.
Root/license reads and metadata remain insufficient for final shipped notice closure.

This packet can avoid inventing an extraction algorithm if selected; it does not replace
Control Center discovery/curation or earned removal of current CR files. Bounded retrieval,
article provenance/storage, quality fallback and safe rendering remain separate seams.
Current summary/source links remain the honest baseline. No E3 article workflow, C3
completion, live research or final selection is established.
