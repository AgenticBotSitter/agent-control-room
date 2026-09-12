# Minimal protected Markdown composition

2026-09-08. Research only, application files unchanged. Conditional recommendation
pending independent challenge, not final F3 or native attachment acceptance.

## Pin, scope and actual integration

react-markdown10.1.0, remark-gfm4.0.1, React/ReactDOM19.2.6 and test-only
jsdom26.1.0. Full resolved URLs/integrities, lock hash and142 installed packages
are in `f3-minimal-acquisitions.json`. Upstream tests were not run. Actual installed
public components execute in `f3-minimal-fit.mjs` under JSDOM.

The actual TaskResultsPanel body from `private-app/app/task-results.tsx` is
transpiled with exactly one research substitution: its text textarea becomes the
Markdown component. All surrounding protected-result identity, warning, empty
state, close callback and review separation remain actual source. Child review
commands are disabled in synthetic data; substitutes throw if unexpectedly called.
Actual checkedResultBytes validates supplied fixture bytes before rendering.
No protected HTTP route, login, real stored result or native provider is exercised.
The earlier mounted protected API evidence remains distinct, not rerun here.

## Results

`f3-minimal-evidence.json`:11 checks pass in610.4ms for the full synthetic run,
including3000 paragraphs near the existing64KiB byte limit. That is not a production
latency benchmark. Heading/table/checklist/code render; checklist is disabled.
Exact code text and canonical file label survive. Raw HTML is skipped, image
syntax creates a label rather than a resource element, only HTTPS links become
explicit navigation, and prose cannot create review commands. Switching content
clears prior text/identity; empty result and parent removal remain correct. Close
only calls the supplied view callback. React root unmounts and DOM closes.

JSDOM does not prove browser CSP, network isolation, layout/accessibility or every
Markdown parser attack. Its lack of resource elements is the measured claim, not
a general sanitizer certification. URL/file policy is a small authored adapter,
not an upstream guarantee. Actual authorization generation/race tests remain
required when wiring the component, even though parent removal works here.

## Comparison and adaptation cost

Prefer this direct maintained parser composition for protected text/table/code
display over copying Desktop AgentMarkdown or WebUI's whole renderer. It crosses
the actual existing panel with one JSX substitution plus a small explicit link/
image adapter, without native IPC, syntax highlighter, shared expansion maps or
global session state. Parser code is reused, not reimplemented.

Desktop remains a viable donor for optional code/diff controls or media UX after
message-scoped state, query-URL recognition and protected media mapping; preserve
its20-check evidence and findings in f3-renderer-fit.md. WebUI's distinct selected
composition failures remain in f3-webui-renderer-fit.md, including its failed
acquisition cap. Neither whole project is rejected. The current textarea remains
a plain-text fallback but does not provide the requested rich reading experience.

This smaller baseline intentionally does not solve attachments, syntax colors,
copy buttons, interactive expansion, lightbox or streaming transcript history.
Add those only through separately reviewed controlled components bound to exact
project/run/artifact identity. Existing protected artifact routes, not a raw native
path or model-generated URL, must control file access. Do not drop these product
requirements simply because this smaller experiment passes.

## Licensing, resources, maintenance and rollback

Actual installed react-markdown and remark-gfm LICENSE texts were read: MIT.
Preserve notices and audit complete shipped dependency closure; test jsdom is not
automatically a production dependency. Version/integrity locks aid reproducibility,
not an assertion of vulnerability freedom. No current advisory audit is claimed.

Preparation checked148,303,536,128 free bytes; retained cohort83,940KiB includes
npm cache, test DOM and package metadata, not production payload/RAM. First attempt
failed before dependency resolution because npm rejected the same file as user and
global config; failed receipt retained. Distinct empty config paths fixed setup,
scripts remained disabled. No production bundle comparison measured. Adaptation
size is small in this fixture but total production wiring cost remains unknown.
No schema migration or production lines removed. Rollback restores textarea with
unchanged retained bytes/reviews, not a database or authority rollback.

## Decision gate

Functional fit and lower host coupling favor direct Markdown/GFM for this narrow
responsibility. Security/render completeness, production resource delta and native
file mapping are unresolved; do not score those unknowns as zero or assert an
overall quantitative winner. Independent source/receipt challenge and the final
nine-field/rubric disposition remain before closing RC3's selected presentation.
