# RC7 discriminating HTML compatibility evidence

2026-09-08, baseline17bef80. **Actual Readability0.6.0 with jsdom26.1.0 met all five new synthetic content/link expectations; the bundled parser met none completely.** This establishes a concrete robustness tradeoff on these inputs, not a general extraction-quality benchmark or a final winner. The exported upstream readability heuristic works with jsdom on the two selected old inputs, unlike the bundled DOM.

## Fixed workload and execution

Stage zero first returned `ready_for_runtime_check` without native operations. New original corpus is `research/reuse-comparisons/f7-html-compat-corpus.json`: substantial repeated article paragraphs with CORE_A/CORE_B, expected resolved links, and an exact decoded entity marker. Cases intentionally use unquoted attributes, omitted end tags, malformed nesting, standard HTML void `<base href>` and named entities. No normalization or selector shim was added. The earlier six-case extraction corpus was **not rerun**.

Actual unchanged published sources are checked before imports: Readability, JSDOMParser, Readability-readerable and jsdom API, same hashes as previous packets. Two DOMs each process five new inputs through actual Readability. Each extraction is an owned Node subprocess with5-second timeout and bounded output; all ten terminated normally, none timed out. Data errors remain in output, so process exit0 does not mean successful extraction. Parent preserves every child status/signal/error/output/diagnostic. No harness repairs needed. No downloaded upstream tests repeated; prior pinned source/tests/license inspection remains scoped as previously recorded.

jsdom input is passed to its string constructor with scripts disabled and a custom ResourceLoader returning null without network delegation. Resource attempts were0 on these new fixtures. Bundled DOM has no resource loader or script execution engine in its inspected implementation. These are in-process parser boundaries, not OS security certification. No app collector, provider, credentials, DB or service invoked.

| New case | jsdom + Readability | Bundled DOM + Readability |
| --- | --- | --- |
| Unquoted href/class | Main markers and resolved guide link preserved | Constructor rejects incomplete Document; markers/link absent |
| Omitted closing tags | Main markers and resolved guide link preserved | Constructor rejects incomplete Document; markers/link absent |
| Malformed nesting | Main markers and resolved guide link preserved | Constructor rejects incomplete Document; markers/link absent |
| Standard HTML base href | Guide resolves `/docs/guide` as expected | Article markers present, but guide resolves `/news/guide`, ignoring intended base |
| Named entities | `© é — 😀 &` decoded as expected | `&copy; &eacute; &mdash;` remain literal; numeric emoji and amp decode |

The small bundled DOM openly documents a properly formed HTML/XML expectation; `readAttribute` requires quoted attributes, its parser expects matching closing tags, and decodeHTML only implements XML's five named entities plus numerics. These results are consistent with that source contract, not a security vulnerability allegation or evidence that Readability scoring itself fails. Standard HTML's void base element is a useful differentiator between browser-like HTML parsing and this narrow XML-like implementation. No fallback rewriting was added to hide it.

## Supported optional heuristic, separately exercised

`isProbablyReaderable` (actual top-level exported function) was called with jsdom on only the prior `article-relative` and `navigation-only` input documents. It returned true and false respectively. No prior extraction was rerun, and no old baseline result changed. This is a real upstream optional gate, not new custom scoring. Source requires querySelectorAll and node.matches; jsdom supports those whereas the prior bundled-DOM test threw. Two observations do not establish broad false-positive/false-negative rates: short articles, unusual structures and adversarial pages remain untested. If root adopts a heuristic, fallback to the original source link should be explicit rather than implying a false result proves no article exists.

## Practical integration implications, not selection

The one-package bundled path is smaller but is not an equivalent raw-HTML substitute on this expanded corpus. Achieving jsdom's observed behavior would require a conforming normalizer/parser before it or new DOM/selectors/entity handling. That could erase its apparent reuse advantage; **do not build those custom subsystems to rescue it**. It remains a possible specialized option for already-normalized serialized markup, with its MPL2 file-level obligations and subpath API caveats unchanged.

The actual jsdom path is documented in Readability's README and upstream tests, handles the tested HTML and supports the existing heuristic. Its40-package closure and larger memory footprint remain real costs. Root may compare it with Miniflux's actual pure extractor, keep summaries only, or investigate a genuinely maintained compatible smaller DOM if decision-changing. This report does not require jsdom adoption or conclude every alternative on the Internet is inferior.

No current product code earned deletion. Future full-article enrichment would use a bounded retrieved-body/approved-final-URL boundary, preserve source/story identity, return untrusted content and metadata, and keep existing news collection/research workflow. Root owns retrieval, budgets, HTML sanitization, presentation, evidence and publication scope. Prior onclick retention still forbids treating extraction as sanitization.

E2: actual candidate components on original synthetic HTML, not live publisher retrieval or full Control Room E3. Scoped rubric update only: jsdom-backed HTML fit4 on this corpus; bundled raw-HTML fit1–2, adaptation effort1–2 if required to handle these cases versus3 for upstream jsdom integration. Maintenance/API and notice differences remain prior findings. Custom avoidance favors using an existing conforming parser rather than building repairs. Resource judgments must retain memory/allocation tradeoff; no weighted winner assigned.

## Resource, license and cleanup evidence

Child peakRSS ranges: jsdom104576–105456KiB; bundled47920–48208KiB. Child elapsed intervals include DOM import/construction plus extraction: jsdom122–129ms, bundled1.9–3.4ms (three bundled cases fail early). These are one cold execution per case, not an equal-success throughput comparison or production sizing. No memory superiority conclusion offsets failed required semantics automatically. Parent overhead is not included in these child peaks.

Same prior pinned40-package lock/integrity closure reacquired with `npm ci`, scripts/audit disabled, owncache and no HOME override;40/40 identities/integrities matched and exact lockhash unchanged. Node22 baseline retained. Initial139GiB free; prior scoped cohorts227004KiB. Current cohort19MiB on disk, compared with prior30MiB install/cache snapshot—not a newly reduced dependency set. Registry request timeout20s/no retries; install reported657ms. No native optional canvas installed. One deprecation warning retained; no vulnerability audit or complete license clearance claimed.

Archive URLs/integrities and complete lock are in `f7-html-compat-acquisitions.json`; Readability Apache2, bundled parser MPL2 and jsdom MIT/source/dependency notices remain prior recorded scope. No library modification or app dependency change. All child processes terminal; exact owned root removed and absence test succeeded. No active services/live handles, GitHub or Git writes. Root review and final decision pending.
