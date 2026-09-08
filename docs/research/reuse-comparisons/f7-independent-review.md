# Independent F7 fit and alternatives review

2026-09-08. Source/evidence review only: no tests rerun, downloads, services,
credentials or installations. Inspected F7 reconciliation, parser-comparison test,
integrated inventory, candidate dossier/receipt/acquisition ledger, actual borrowed
parser/direct decoder/ingestion, and actual `abs-research-native-journey.test.ts`.
Spot-checked retained candidate source for API extraction, parser wrapper/cache and
manifest scope. No dependency-wide or legal license approval is provided.

## Disposition

**No blocking defect in the claimed scoped evidence.** Retain current Control Center
collection and postpone parser removal until parity/migration evidence is reasonable.
This does not accept all F7 candidates, new extraction engines, real research quality
or a live news deployment. The dossier explicitly preserves those gaps.

## Borrowed journey fidelity

- Journey actually invokes `createControlCenterCollection` with injected DNS/fetch,
  discovers RSS from synthetic homepage HTML and persists the resulting story.
  It reads through actual private news API, prepares verification-first task, saves
  with replay check, and verifies exact original task/input digest reaches execution
  plan. It is not merely a hand-constructed story fed to a UI.
- Result lifecycle uses existing synthetic native fixture. Returned bytes are
  predefined `qualityText` plus source URL; successful document-structure verification
  does not establish factual research, retrieval of the article or agent usefulness.
  This is explicitly disclosed, so E3 in-process composition is appropriate.
- Denied result read401, quality-before-complete refusal, verified review/completion,
  replayed receipt and single accepted review/effect checks are visible in source.
  Parent's recorded one passed journey is consistent with this test scope. This
  reviewer did not independently execute it or observe past process cleanup.
- Local vendor hashes/inventory establish actual reused modules; they do not prove
  every adapter is upstream-identical. Dossier correctly separates identical curation
  hash from adapted source snapshots and avoids calling all2137lines new code.

## Parser comparison and deletion decision

The three tests call actual installed paths using identical supplied RSS bytes.
They establish one regular-item field match, missing-title/relative-link policy
differences, and direct100-item rejection versus borrowed101-item acceptance.
The compared objects are **parser+adapter policies**, not a pure benchmark of XML
libraries. Missing-title fallback and relative normalization occur visibly in borrowed
`parseFeed`; strict direct rejection and caps occur in `decodeAbsFeed`. Therefore the
finding supports keeping legacy behavior until an adapter migration is proved, not
claiming either library intrinsically cannot implement the other policy.

Nonblocking improvement F7-R01: the third test name says "capped sorted slice", but
101items do not hit the borrowed250cap and all dates are equal. The source itself
shows `.sort(...).slice(0,250)`, and prose distinguishes the observed101 from fixed250,
so no result is false. Rename test to the observed behavior or add >250items with
different dates before claiming an executed cap/order test.

The proposed35–60line shared mapper savings are clearly estimates, not measured
deletion. Important migration details are correctly retained: existing plan kinds,
receipts, source kinds and distinct digest material must not be silently rewritten.
Current two paths compute evidence from different source material; sharing a helper
must preserve byte/digest contracts, not merely produce similar displayed fields.

## Strong alternatives / source screening honesty

- Miniflux is a credible separate reader/API or extraction-helper candidate, not
  dismissed for Go. Per-user entry lookup and optional writeback mean its fetch API
  is neither a passive read nor canonical task authority. Local runtime/quality cost
  remains explicitly unmeasured.
- FreshRSS separate-service interoperability remains a candidate despite source-copy
  licensing constraints. Root licensing is not treated as proof service integration
  has no obligations. API credentials/read-star state are kept distinct from Access
  and verified research state. PHP execution is explicitly unperformed.
- RSSHub is scoped to feed generation. Actual wrapper's rss-parser version alone
  does not imply parity with installed package because upstream patches/overrides
  exist. Cache claims are not promoted into global task ownership. Current license
  discrepancy versus older snippets is surfaced rather than hidden. No route was run.
- Direct Mozilla Readability remains a materially strong extraction alternative.
  Dossier explicitly calls it unevaluated. This is an open decision-changing local
  comparison if full-article extraction is in accepted outcome scope; do not bury it
  as merely future work while claiming F7 universally complete.

No numerical winner was invented from source-only cards. Existing integration can
remain preferred for the working feed→task path without proving it is best at richer
full-article extraction or no-RSS generation. Those are distinct responsibilities.

## Cleanup and next acceptance

Candidate acquisition ledger honestly says cleanup pending at review time; source
root existed for spot checks. Do not change that to complete without exact cleanup
verification. Prior in-process tests' close behavior/terminal outcomes are reported,
not independently re-observed here.

Accept this reconciliation/source-screening checkpoint. Next comparative gates are
the listed multi-format/error/digest parser corpus before consolidation; actual
chosen extraction candidates on identical local HTML if extraction is required;
and actual selected generated-feed route against a synthetic upstream before claiming
RSSHub fit. Real source/native/worker/browser/operations acceptance remains separate.
