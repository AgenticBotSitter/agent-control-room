# RC3 competing WebUI renderer: exact source packet

2026-09-08; existing pin `nesquena/hermes-webui@e168b67e4278df618d1cab61fdb3a8dc55b29a81`.
Source-only, no candidate/service/DOM execution. This is not another sessions-helper
test and not whole RC3 acceptance. Root retains selection and adaptation authority.

## Located real paths

- `static/ui.js::renderMd` starts at line7522 and spans34,762 source characters.
  This is the settled-content rendering path, not an external marked wrapper.
  Its nested functions include `_markdownHref`, `_markdownAnchor`, `_isSafeUrl`,
  list rendering and label filtering. Its complete body was subsequently read,
  including the initially truncated excerpt via in-memory slices. No function ran.
- Same module `highlightCode` line19398 was read completely: select only
  `pre code:not([data-highlighted])`, invoke `Prism.highlightElement` if provided,
  then mark `data-highlighted=1`. It avoids repeated scans of already highlighted
  blocks but depends on a real Prism runtime; no highlight quality was executed.
- Actual media path is `_inlineMediaHtmlForRef` line2725, with
  `_isSafeDataImageUri` line2699, playback helpers, `_mediaSessionQuery` line19650
  and snapshot routing. Those four function bodies were read. Local references are
  routed to `api/media?path=...` with an explicit or current global session ID;
  HTTP(S) references use direct image/player markup. Query strings are removed
  before extension classification, unlike Desktop's observed query-string mismatch.
  The helper also rewrites localhost/127.0.0.1 media URLs to document.baseURI.
  That is a host-specific behavior, not something Control Room should inherit silently.
- `static/messages.js` has a separate streaming path: parser_write/end,
  `_sanitizeSmdLinks` line4560, `_streamFadeRenderer` line4643,
  `_safeSmdRenderer` line4955, media-tail buffering and parser identity functions.
  Streaming and settled rendering must both be evaluated; testing one does not
  qualify the other. Actual `_sanitizeSmdLinks`, `_safeSmdRenderer`, parser-identity
  binding and reliable-media-boundary bodies were read. The safe wrapper intercepts
  href/src setters before delegating, and routes text through buffered media-aware
  handling. The full fade renderer and media-buffer closure were not read/executed.
- `static/index.html` imports vendored `static/vendor/smd.min.js`; comments name
  streaming-markdown0.2.15 and a SHA384. Actual12,586-byte vendor content was hashed:
  SHA384 matches the HTML comment exactly; SHA256 is in the receipt. This proves
  correspondence to that vendored file, not upstream release provenance or license.
  Prism core/autoloader1.29.0 come from jsDelivr with integrity attributes;
  the theme tag has no integrity attribute in this inspected HTML. Its xterm tags
  are terminal dependencies, not necessary Markdown renderer imports.

The earlier same-pin MIT root notice applies to WebUI source; external/vendored
parser/highlighter, theme, math/fonts and any optional rich diagrams require their
own precise notice/provenance closure. Root MIT was reread (2025 Hermes Web UI
Contributors); it does not license every bundled asset. No full SMD/Prism notice
closure was obtained. The inspected SMD header/tail has no notice; that limited
inspection is not a claim that every source or upstream distribution lacks one.
The actual package.json contains only ESLint dev tooling, not a renderer runtime
lock graph. A runtime prototype must pin actual browser-script artifacts rather
than treating that package file as complete dependency/provenance evidence.

## Actual settled implementation and tests

`renderMd` is a custom sequential HTML-string parser, with recursive blockquote
handling and many stash/restore passes. It decodes entities, handles backtick fences,
inline code, math placeholders, lists and pipe tables, then applies custom tag,
attribute/class and URL allowlists. Code is escaped before storage. Diff/patch
blocks add colored line spans; JSON/YAML tree and CSV table placeholders are richer
than current CR's textarea. CSV here is split on commas, not a general quoted-CSV
parser. Mermaid-like fences become optional diagram placeholders, not executed
diagrams in this source evaluation.

Its final tag pass strips disallowed attributes and rejects javascript/vbscript and
most URL schemes after whitespace/control normalization. Accepted mailto/tel/message
and internal session/workspace/file routes differ from Desktop's link-dispatch
contract. Raw incomplete tags receive an extra escape pass. Some generated stashes
(fenced blocks, math, MEDIA, recursive quotes) are restored after the general tag
pass. Therefore a fair test must execute those actual generators/helpers too;
replacing media with an inert stub does not qualify the resulting HTML. This is
source structure, **not an XSS exploit claim or sanitizer certification**.

`_inlineMediaHtmlForRef` handles base64-image policy via `_dataImageHtml`, file URLs,
remote images/audio/video and local PDF/HTML/diff/CSV/Excalidraw lazy placeholders.
`_isSafeDataImageUri` delegates to shared length/regex constants. Those constants,
`_mdImageHtml`, `_dataImageHtml`, `_smdImgSrcAllowed`, playback/lazy loaders and actual
media endpoint authorization were not all inspected in this packet; they remain
explicit closure inputs before runtime. The helper comment describes a session
allowlist backend, but this source read does not verify that backend authorization.

Three real upstream test files were read, **none run**:

- `tests/test_renderer_js_behaviour.py` executes extracted actual renderMd and fence
  helpers under Node. It checks nested quotes/fences, lists/tables/entities,
  session links, raw attribute/scheme stripping, incomplete HTML and media-shaped
  cases. Its document is a tiny stub and `_inlineMediaHtmlForRef` is a handwritten
  stand-in. These are useful regression inputs, not mounted actual-media evidence.
  The extractor counts braces rather than parsing JavaScript syntax; our next
  harness should use the existing TypeScript AST extraction and pinned hashes.
- `tests/test_issue6209_data_image_renderer.py` extracts real small shared media
  functions and both streaming guard wrappers. It expects encoded SVG/HTML data
  blocked and base64 PNG admitted, checks exact delegated setter calls and author
  alt text. Its `smd.default_renderer` is synthetic, as are several media/runtime
  helpers: it does not execute the real streaming parser or fetch/render an image.
- `tests/test_issue_code_syntax_highlight.py` checks source substrings for language
  classes/layout. It does not establish actual Prism token output; Desktop's actual
  positive token acknowledgment is stronger evidence for that single responsibility.

No upstream test count or successful execution is inferred from their existence.

## Current Control Room and fair comparison boundary

`private-app/app/task-results.tsx` lines32–38 places already-read verified result
text in a read-only textarea with artifact ID, fingerprint and explicit warning
that opening content grants no execution/review. Replacing that presentation can
improve readability, but its result-byte verification and review binding are not
duplicates of either candidate renderer.

Desktop's completed20 mounted checks cover actual GFM, one unsafe-link/raw-script
case, code/highlighter/diff/box, copy, streaming state, local/direct media and
lightbox/remount behavior. WebUI does not receive those passes by analogy. The
next actual comparison should feed the same corpus and callback observations into
its real renderer closure, preserving its safe-link/media helpers rather than
substituting an inert Markdown span. A separate live-stream corpus must account
for split links/media prefixes and completion transitions.

| Responsibility | WebUI source alternative | What can change our choice |
| --- | --- | --- |
| Settled rich text/code | Custom renderMd HTML pipeline, existing regression corpus, Prism markers | Actual same-corpus DOM behavior and importing cost versus maintained React Markdown/GFM; source-only does not beat Desktop20 runtime observations. |
| Streaming | Actual parser interface and per-parser media-tail ownership, not full-string React remounts | Real vendored parser with actual guards across split schemes/media/fences, finalization and two simultaneous message owners could justify a narrow streaming donor. |
| Query media/audio/video | Query-aware classification and existing rich placeholders | Positive/negative same URLs, no native IPC; prove host artifact routing without importing global S/current-session assumptions. |
| Diff/tables/math | Useful isolated presentation and optional enhancements | Adopt only required pieces; do not pull rich-preview loaders, diagrams or math/font dependencies into an MVP merely because present. |
| Result authority | WebUI URLs carry session/path, not CR artifact/digest/review tuples | Retain current protected read/review machinery. No source here replaces that responsibility. |

No application code or new parsing infrastructure is proposed. The strongest
smaller option remains maintained Markdown/GFM primitives within current protected
result presentation, optionally adopting useful display helpers. Importing WebUI's
entire global session shell to get Markdown is not justified by this source screen.
Language/framework difference alone does not exclude reuse: an isolated renderMd
adapter is feasible. Its custom sanitizer and duplicated settled/streaming behavior
are concrete maintenance costs, not evidence that it is defective.

**A bounded actual fixture could change the choice for streaming and media**, so
do not reject WebUI without it if those pieces remain required. First acquire the
exact missing helper/constant closure, then run real settled renderMd and real
vendored parser with their actual guards on the Desktop corpus plus fragmented
input/dual-owner cases. Mount generated HTML in a no-resource DOM and acknowledge
real Prism token output. Use synthetic navigation/media transport only, not fake
parsing/sanitizing components. Document control/status/review features as excluded.
No full Python service or global session dashboard is necessary for this comparison.

## Bounds and present limitation

The first phase logged3,133,174 public response bytes, just below3MiB, including one
repeated tree and two404 path probes. No files were downloaded into a temporary
source tree, installed or executed. An extraction-name mismatch omitted the
`renderMd` body from the returned excerpt. That omission is not called an inspected
implementation; root approved an additional1.5MiB before more reads. Cumulative
response bytes are now4,679,353, below the explicit4.5MiB total. All URLs, statuses,
hashes and repeated reads remain in the receipt. Only authored analysis/receipt
files are retained; no downloaded code, dependency cache, service or temporary
root exists to clean. The parser body/source screen is complete to the stated
scope; full runtime dependency/license closure and execution remain uncompleted.
