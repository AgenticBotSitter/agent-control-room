# RC7 parser consolidation: bounded integration result

2026-09-08. Research only; current application and lockfile unchanged.

## Finding

An actual legacy ABS decoder, with only its `rss-parser` import substituted by a
research adapter over installed fast-xml-parser, preserved complete output in 14 of
18 synthetic cases. Four mismatches were material: HTML entities, Atom XHTML, bad
RSS dates and bad Atom dates. Explicit compatibility adaptations brought this
corpus to 18/18 exact output matches, including source/story/curation digests.
This supports further consolidation testing, not universal feed compatibility.

The same experiment exercised actual borrowed Control Center parsing and reader
code: 260 dated items retained the expected latest 250; an undated first read created
a quiet baseline, replay emitted nothing and a changed entry emitted one item.
These are supplied strings and three synthetic readText calls, not network requests.

Evidence: [fixture](../../../research/reuse-comparisons/f7-parser-decision-fit.ts),
[saved execution](f7-parser-decision-evidence.json). The receipt records exit0 and
18/18 adapted parity, with all four original mismatches retained. The author's
session subsequently failed authentication before writing its narrative; root
inspected the saved files and receipt rather than claiming the handoff was complete.
The author reported an initial cross-realm plain-object digest mismatch and corrected
the harness to execute in the same JavaScript realm. Raw output for that initial
harness failure is not retained here; that statement is author-reported only.

## What is reused versus new

Installed candidates: rss-parser3.13.0, fast-xml-parser5.11.0, entities2.2.0 from the
rss-parser dependency resolution. The experiment executes actual full
`src/project-adapters/abs-news/v1/feed-decoder.ts` after transpilation, intercepting
one import. It imports actual `src/vendor/control-center/sitemap.ts` and
`source-reader.ts`. It does not replace collection/task authorities or SQL services.
The compatibility parser itself is new research glue, not an upstream supported
rss-parser-compatible API. Its snippet stripping adapts MIT rss-parser code and
must retain upstream attribution before any distribution. It currently resolves
entities via rss-parser; removing rss-parser would require an explicit dependency
or another parity-tested entity implementation, not simply deleting the package.

## Decision and next action

Provisional option: consolidate onto already-installed fast-xml-parser with a narrow
legacy-shape adapter, **only if** broader legacy feed tests and persisted digest
compatibility pass. Strong alternative: keep both existing parsers, with zero migration
and no compatibility fork. This small corpus does not yet establish that extra adapter
maintenance is cheaper than retaining rss-parser. No final winner or weighted score.

Potential removal is the direct rss-parser dependency and its otherwise-unused
transitives after dependency-graph verification. Do not delete the legacy decoder,
borrowed reader, downstream policy or task/source translation merely because XML
parsing is shared. Product code removed in this experiment: zero.

Before accepting: independent review; reproducible pinned source/dependency checks;
exact upstream notice coverage; representative namespaces, HTML/XHTML, empty/multiple
elements and legacy persisted plans; existing full feed/collection suite with the
adapter; measured standalone footprint/cost and rollback to original import. The
current prototype logs a source hash but does not assert the expected pin. Installed
source and lock identities must be checked before reproducing at a later revision.
No downloads, services, provider calls or production effects were needed.
