# RC7 bundled Readability DOM alternative

2026-09-08; baseline17bef80. **The bundled JSDOMParser plus actual Readability0.6.0 matched the earlier jsdom path on the same six synthetic scenarios, with one installed package instead of40. It is not a drop-in full DOM, and its file-level license is MPL-2.0, not the package's Apache-only metadata.** No final extractor/DOM selection made.

## Pin, interface and source limitations

Same registry package `@mozilla/readability@0.6.0`, gitHead `4d5dd0bbe0bfbc44e219dc86865131e79639e30b`; exact prior archive integrity confirmed in acquisition ledger. `JSDOMParser.js` hash `6b8eae46939f187ef4565c67f452a9098211daea80e50c9aea74d72015b73680`, actual Readability implementation hash `34dcab3d0832d0019f02990eed6b6124e029e8c32b9f0c6f2550544ff8dff174`, both checked before import.

The parser is a shipped CommonJS subpath (`@mozilla/readability/JSDOMParser`, module.exports at1277), not exported by the package's top-level index or declared in index.d.ts. Package has no exports restriction. Upstream tests explicitly exercise its `parse(source,uri)` alongside jsdom on expected article DOM/content/title/byline/excerpt cases; those actual pinned test sources were read in previous packet, not rerun or downloaded again. README Node example recommends external jsdom. Thus this is an accessible upstream-tested bundled module, not a documented full stable Node DOM API. No fork/shim was added.

Header explicitly says minimal DOM, properly formed HTML/XML required, non-live arrays, and warns about raw XMLHttpRequest responses. `parse(html,url)`1243 builds plain Document/Element/Text objects. Document stores documentURI and computes baseURI from first base href at638. readAttribute expects quoted values; it is not HTML5's forgiving parser. Actual module implements no resource-loading or script-execution facility; JavaScript text is treated as input string/node content, not evaluated. The source's references to XMLHttpRequest are comments, not executable retrieval. Node's normal module execution is not a hostile-code sandbox. The global script marker assertion only corroborates the selected script fixture; it does not certify arbitrary JavaScript isolation.

## Same-corpus evidence

`f7-readability-builtin-fit.mjs` asserts the shared corpus hash equals the previously executed jsdom receipt before any parsing. No normalization, corpus edits or expected-results changes.

| Scenario | Bundled parser + actual extractor |
| --- | --- |
| Article title/main markers/relative link | Matches expected; documentURI/baseURI retained, guide resolves correctly |
| Navigation/script-rich article | Main markers retained, navigation/footer removed, script tags absent; **onclick remains**; global script marker not set |
| Empty | null / no article |
| Navigation only | **False positive:** article returned, same expected-noarticle mismatch |
| Oversized bytes | Same caller gate rejects before parsing; candidate not executed |
| Oversized elements | Actual Readability maxElemsToParse rejects after DOM creation (67 elements) |

Five of six expectations match, including the noncandidate byte-gate case—not six extractor passes. Pure parser produced no errorState in these five executed corpus items. First execution exited0 without repair; negative navigation classification remains in receipt. No browser, request loader, script engine or listener was created. Extracted HTML remains untrusted, as the retained onclick demonstrates. Existing collector and presentation were not invoked: E2 extraction-only evidence, not full article workflow E3.

Root independently compared the two saved receipts: same corpus hash and all six rows' disposition/title/textContent/content/expectedMatched fields, including nulls, agree. Actual returned text and HTML strings are byte-identical on this tiny corpus. This does not establish general DOM equivalence on malformed or real publisher pages.

## Separate optional upstream readability heuristic

Root requested checking exported `isProbablyReaderable` as an optional existing quality gate. Source `Readability-readerable.js` hash `a98d28805804c1986ceed470678a3f409f150ee7f1d227f8c8239c005d21de65` checked before execution. Actual implementation calls document.querySelectorAll twice and node.matches, then applies visibility, min length and score rules. The bundled DOM lacks querySelectorAll.

`f7-readability-builtin-heuristic.mjs` called the actual exported function on the same five parsed inputs; all five throw `doc.querySelectorAll is not a function`; byte-gated case skipped. These are API incompatibility errors, not negative readability classifications or a repaired fallback. Baseline parse outputs were not changed. No custom selector/score shim introduced. Testing that heuristic with jsdom or selecting another supported DOM remains a distinct possible comparison if root needs it; this packet does not imply the heuristic is broken on compatible DOMs.

## Cost, licensing and recommendation boundaries

This path materially reduces the tested dependency closure: one package,292KiB installed+cache versus the prior40-package jsdom cohort30MiB. It also avoids resource-loader configuration because the bundled parser has no loading engine. However, real publisher HTML often relies on permissive parsing; these mostly well-formed synthetic cases do not establish equivalent robustness. A meaningful next selector test would compare malformed/unquoted/omitted-closing-tag inputs and actual supported optional heuristic needs before choosing a DOM. Don't add a custom HTML normalizer or CSS selector engine simply to preserve the smaller dependency count.

Actual JSDOMParser header is **MPL-2.0**, while Readability/readerable files carry Apache2 headers. Keep original notices, distinguish file-level licensing and obtain root's redistribution review before shipping. This does not automatically prohibit an Apache-licensed larger project or imply entireproject relicensing; it is also not automatic clearance. Full license obligations/source delivery and exact packaging remain F9 work. No JSDOMParser source copied or modified in the product. The prior external DOM package has its own MIT and transitive obligations; neither root license clears all scope.

Provisional rubric0–5 for this narrow path: fit3 (tested extraction fits, incomplete DOM/heuristic mismatch), effort3 (subpath+typing/security/HTML compatibility assessment), custom avoided4 (real parser+extractor, provided no new selector/normalizer is built), maintenance2–3 (upstream-tested but not top-level documented API), resource comparison3–4 narrowly for observed local allocation, not production throughput. Retain current summaries/no extraction is still valid until richer reading is selected. Miniflux comparison remains separate, and no winning option is declared here.

Whole-process peakRSS52800KiB on this single sequential fixture versus prior113520KiB with jsdom; same corpus, separate unrandomized process runs, not a warmed statistical performance comparison. Includes Node/harness/imports, not extractor-only or production memory. Startup/import timing and malformed-page worst-case resources remain unknown. Per-case timings retained only as diagnostics.

All exact one-package archive/integrity and cleanup details in `f7-readability-builtin-acquisitions.json`. Initial139GiB free; scoped other roots227136KiB. Scripts/audit disabled. Exact292KiB owned root removed; absence test succeeded. No active processes/services or app/Git changes. Research receipts and originals retained; download removed. Author has not self-approved selection.
