# RC3 actual WebUI renderer: useful reuse, unresolved streaming boundaries

**Cleanup update:** After root review/hash checks and no-open-handle check, the
exact temporary cohort below was removed and absence verified. The retained-state
paragraph preserves the author's pre-cleanup handoff, not current disk state.
See `f3-webui-renderer-root-review.md` and acquisition ledger `rootCleanup`.

2026-09-09 UTC. Same pin `e168b67e4278df618d1cab61fdb3a8dc55b29a81`.
**This is negative/partial evidence, not a passing renderer qualification.**
The first actual run completed17 assertions before a streaming-highlighting
expectation failed. One permitted fixture correction recorded that unmet capability
separately; the next run completed18 assertions, then stopped because a generated
streaming media image had no src after final sanitization. No candidate code was
patched, no further rerun was made, and independent-owner success is not claimed.

## Actual executed closure

`f3-webui-renderer-fit.mjs` verifies downloaded whole-source hashes and the selected
dependency lock hash before AST extraction. Fifty-two actual function/constant
nodes are retained as name/file/SHA256 entries in `f3-webui-renderer-evidence.json`.
They include full `renderMd`, actual escaping/fence/media helpers, actual data-image
predicates/constants, real `_safeSmdRenderer`, parser identity/tail handling and
final `_sanitizeSmdLinks`. None of those is replaced by a fake parser/sanitizer.
Vendored `smd.min.js` (12,586 bytes; exact earlier SHA256) is transpiled from ESM
exports to CommonJS without rewriting its parser or DOM renderer. Actual Prism
1.29.0 npm runtime supplies JavaScript grammar/highlighting. JSDOM26.1.0 supplies
the DOM with resource loading and script execution disabled.

Synthetic host inputs are `S.session.session_id`, fixture document.baseURI and a
fresh DOM's localStorage. No backend, native port, user profile, browser or real
media resource is connected. Translation is absent and upstream fallbacks run.
Optional postprocessing globals are absent, so actual media postprocess scheduling
returns without invoking PDF/HTML/diagram loaders. Actual playback-control markup
is generated but not presented as working controls. No Approve/Deny UI is imported.
VM execution is not a security sandbox.

This is the selected safe renderer, not the full page or fade animation pipeline.
Main `_smdNewParser` also wraps underscore-emphasis tokens; that wrapper was not
included. It does not rewrite class/src setters in the inspected body. Optional
table enhancements, copy buttons, lightbox, late image fetches, redraw ownership,
full session lifecycle, CSS/browser accessibility and current CR composition were
not exercised. The source files have not been changed to bypass those boundaries.

## Narrow successful observations

- Settled actual table/strike/inline code, escaped executable HTML sinks for the
  chosen script/event/javascript fixtures, normal HTTPS/mailto links and original
  code text. These are a small corpus, not sanitizer certification.
- Real settled Prism token output is positively present; a second highlighting
  pass leaves the marked block unchanged. Actual diff classes and box glyph text
  survive. No claim that WebUI has Desktop's special box-drawing heuristic.
- Query-string `.png?v=1` remains an image, unlike Desktop's observed download-chip
  classification. Local file images use `api/media?...&session_id=synthetic-a`;
  PDF becomes a lazy placeholder, video actual markup, raster data an actual image.
  Encoded SVG and HTML data do not become embedded image/iframe/object nodes.
- Real incremental parser handles split javascript-link/raw-HTML fixtures without
  the tested executable DOM sinks and produces a positive HTTPS anchor. Raster
  data is admitted and encoded SVG src omitted through the actual shared guard.
- Ordinary `/path` Markdown links remain literal in settled renderMd but become
  anchors in the actual streaming parser. This is a reproduced mode mismatch,
  not an inferred security bypass.

## Unmet observations and source-only cause checks

### Streaming Prism expectation failed

The original positive assertion required a `.token` after streamed JavaScript.
It failed, even though the earlier settled JavaScript Prism positive passed in the
same process. The one fixture correction retained the original failure receipt
and recorded exact markup without fixing it:

```
before: <pre><code class="js">const x = 1;</code></pre>
after:  <pre class="language-none" tabindex="0"><code class="js language-none" data-highlighted="1">const x = 1;</code></pre>
```

Actual vendored parser class emission and WebUI highlightCode compose this way.
`highlightCode` marks the block even when no token is produced. Source searches
in the inspected ui.js/messages.js show no intervening language-class conversion;
index.html assigns the imported parser directly to window.smd. The production CDN
autoloader was not loaded here, but JavaScript grammar was demonstrably available.
This rules out absent grammar in this fixture, not every possible whole-page
initialization or later settled redraw. Report the unchanged selected combination
as unmet; do not announce a universal WebUI product defect.

### Independent-owner media assertion stopped on missing src

The second run reached two parser media-image nodes, then `getAttribute('src')`
returned null and the expected path assertion threw. Paths, owner isolation and
global-session leakage therefore did **not** complete their assertions. No captured
DOM before finalization was retained for these nodes; do not fabricate it.

Source provides a narrow explanation: `_inlineMediaHtmlForRef` generates relative
`api/media?...` URLs, while messages.js line4523 `_SMD_SAFE_IMG_URL_RE` accepts HTTP,
mailto/tel, slash/hash/query/dot prefixes but not bare `api`. At line4571 the actual
final sanitizer removes disallowed src. The real `_smdEndParser` lines4442 onward
also invokes that sanitizer after flushing media tails, and anchor finalization
does likewise. The fixture did not invent that ordering. This combination needs
explicit source/URL-contract adaptation before adoption. No backend authorization
conclusion follows, and no global/per-project authority contract is changed here.

Pending extensionless-tail assertion was not reached. No independent-owner success,
cross-project disclosure or whole-browser result should be inferred from the test.

## Decision impact and strongest alternatives

Do not import this whole settled/streaming pair unchanged into CR. The experiment
found real benefits (query-aware media, incremental parsing) and concrete mismatches
(relative-link behavior, streaming class shape and media finalization URL contract).
An adapted WebUI helper or actual streaming-markdown primitive remains a credible
option; a defect in composition is not evidence that all streaming parsing should
be rewritten. Its observed functions can supply useful regression cases.

The smaller alternative remains actual React Markdown/GFM inside current protected
results, borrowing narrowly selected Desktop code/diff presentation. It avoids
the second custom settled parser and WebUI global current-session media route.
Desktop itself requires scoped expansion keys and browser media/navigation ports,
so this is not unconditional Desktop acceptance. Full CR protected content reads,
artifact digests and quality review remain; zero of that authority machinery is
removable renderer duplication.

Judged glue cost: WebUI selected runtime needs explicit message-owned artifact URL
mapping, consistent settled/streamed URL treatment, class/highlight handling and
host component lifecycle. Whole-shell import additionally brings many optional
loaders/session globals and is not justified by this test. No estimated time or
production RAM/throughput savings are measured. Root decides whether another
bounded adapter experiment is worth its cost; no more local rerun is assumed.

## Provenance, resources and retained state

Commands: `node .../f3-webui-renderer-acquire.mjs`, then `...-setup.mjs`;
stage zero returned ready, followed by `node .../f3-webui-renderer-fit.mjs` twice.
First run terminal exit1:17 assertions,21.461ms. Second terminal exit1:18 assertions,
22.381875ms. Both failure receipts remain, including the first unmet Prism assertion.
The only fixture correction did not change source behavior or turn Prism into a pass.

Source acquisition recorded1,725,069 public bytes, exact URLs/statuses/hashes.
Setup installed only jsdom26.1.0/Prism1.29.0 plus transitive packages (40 total),
scripts disabled, dedicated cache/home, empty npm configs, no app install.
The setup's frozen resulting lock, all versions/URLs/integrities and manifest hashes
are logged. Cache audit additionally verifies85 public response bodies with exact
URL/SHA256/integrity/decoded size:15,465,331 bytes. Combined with source,17,190,400
decoded bytes exceeds the10MiB cap, which root confirmed includes package archives
and registry metadata. **The acquisition budget gate failed.** Npm did not enforce
that response cap; this was reported to root and all acquisition/runtime stopped.
No further allowance or compliant-budget pass is claimed. Broader owner download
authorization does not erase this failed gate. Cache sizes are decoded bodies,
not compressed wire bandwidth (unmeasured).

WebUI root MIT and actual Prism MIT full text were read. Package license fields
and manifests are recorded, but entire transitive notices/assets are not cleared.
Vendored parser hash matches the previously inspected HTML SHA384; exact upstream
package-license provenance remains unresolved. No product shipment is authorized.

Owned root `/private/tmp/cr-f3-webui-renderer.U2Jo3s` remains **retained for root
review**,39,456KiB last sampled (about38.5MiB), below150MiB. Free space before
acquisition was145,448,960KiB. These are disk values, not application memory.
All command handles are terminal; both fixture finally blocks clear parser tails/
identities and close the DOM. `lsof +D` returned no open handles for the exact root.
No listeners/native agents were started. Cleanup is explicitly pending root
authorization; neither root removal nor absence is claimed.
