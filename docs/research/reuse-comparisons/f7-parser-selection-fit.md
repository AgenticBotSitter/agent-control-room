# RC7 narrow parser choice: retain both maintained parsers

2026-09-08, source base `f2bac29`. Research only; no application change, download,
service, database, provider, feed request or GitHub operation.

## Decision

**Retain rss-parser3.13.0 for the existing legacy ABS decoder, and retain
fast-xml-parser5.11.0 for the already-borrowed collector/sitemap implementation.**
Do not build and maintain an rss-parser compatibility layer merely to remove this
small second dependency stack. This is a narrow parser decision, not a rejection
of fast-xml-parser, the borrowed collector, or consolidation elsewhere in F7.

The previously corrected adapter remains a credible reusable prototype, but its
18/18 first-corpus result did not generalize to the next18 discriminating cases:
11/18 match complete incumbent output. Translating the actual borrowed `parseFeed`
output into the same legacy decoder matches4/18. Keeping both retains the existing
feed-specific maintained behavior with no new compatibility code or data migration.
Some incumbent outputs are imperfect; changing them should be a versioned content
normalization decision, not hidden inside a dependency removal.

## Real-code experiment and controls

`f7-parser-selection-fit.ts` verifies the prior source/dependency inventory before
imports, and hard-checks the reviewed prototype hash
`3a11a58aea39ff9cb76ba0a293e8200c763767c5b48f217f84cda56f87bed661` before extracting
its exact adapter declarations. Only those declarations execute; the prior18-case
workload is not imported or silently rerun. The adapter is unchanged, in its reviewed
compatibility mode. The actual full legacy decoder is transpiled into the same JS
realm, replacing exactly its rss-parser import. All real policy, curation, canonical
identity, story/evidence hashing and count behavior stays in place.

A second explicit alternative translates actual borrowed `parseFeed` output into
that same full decoder: title, URL, summary and parsed timestamp. This is a thin
output adapter, not a claim that borrowed internals are interchangeable with
rss-parser. Its output has already lost missing-title, raw-relative-link and
long-summary information. Repairing those differences requires raw XML extraction
again or intentional legacy-contract changes, not simply a better output mapper.

The new corpus expands existing `abs-news-feed-decoder.test.ts` requirements for
Atom links, item/byte refusal and immutable provenance, and
`control-center-discovery-upstream.test.ts` namespace/multi-format requirements.
New distinguishing cases add mixed content, repeated scalar fields, fallback dates,
numeric title preservation and content-versus-summary precedence. These are synthetic
fixtures inspired by actual current code requirements, not a claim upstream test
suites or publisher data ran unchanged. Some matched results are deliberate
rejections; Atom summary-only parity retains the incumbent title fallback, not summary.

## Findings retained, not repaired until a winner appears

| New adapter mismatch | Existing rss-parser outcome | Corrected fast-xml adapter outcome |
|---|---|---|
| Prefixed Atom | invalid_feed | accepts a story; broader support but changed legacy behavior |
| Mixed inline RSS title | `AI today` | `AItoday`; changed content/evidence digest |
| Repeated RSS title | first title retained | item rejected |
| Repeated RSS description | first description | concatenated descriptions |
| Empty Atom published with valid updated | uses updated timestamp | invalid_feed |
| Mixed XHTML body | `Before afterbold` | `boldBeforeafter`; both illustrate normalization limitations |
| Repeated Atom content | first content | concatenated content |

The borrowed-output alternative additionally changes leading-zero titles, missing
title fallback, relative links,600-character summaries, content:encoded precedence,
date fallback and Atom summary handling. Its14mismatches are listed with full-output
hashes and relevant story fields in the receipt. This does not make the collector
defective: it follows a distinct accepted discovery policy. Its successful earlier
250-entry sorting and undated baseline/replay evidence remains valid.

No attempt was made to patch each newly discovered difference. Doing that would
grow our own feed normalization implementation—the opposite of the owner's reuse
preference—without an accepted new capability or measured operational need.

## Exact cost and removal boundary

Current `src` consumer scan finds one rss-parser import:
`src/project-adapters/abs-news/v1/feed-decoder.ts:1`. Current pnpm lock has only
rss-parser→xml2js0.5.0→sax1.6.1/xmlbuilder11.0.1 incoming dependency edges for those
versions. Removing the direct package could therefore remove those four package
nodes from this application's selected graph, after clean-lock verification.
It does **not** justify deleting unrelated global pnpm store data.

Installed allocated sizes from `du -sk`:

| Potential removed package | KiB allocated |
|---|---:|
| rss-parser3.13.0 |1872|
| xml2js0.5.0 |68|
| xmlbuilder11.0.1 |276|
| sax1.6.1 |72|
| Total possible removed allocation |2288|

Entities2.2.0 (112KiB) must remain explicitly declared/imported for the tested
candidate. Existing fast-xml-parser and its dependencies already serve the collector,
so replacing them with rss-parser would require another sitemap XML implementation;
that is not an equivalent dependency saving.

The reviewed candidate extraction is30lines of densely written research declarations
(see receipt's exact count), not production-ready maintainable code. It adds raw feed
shape normalization, entity/snippet compatibility, XHTML rebuilding and date-policy
maintenance. The smaller borrowed-output mapper cannot restore information already
discarded. Neither alternative deletes the98-line provenance decoder or the114-line
collector ingestion adapter: both own distinct evidence/contract responsibilities.
Actual product code removed:0. No RSS throughput, peak-memory or startup-speed benefit
was measured. Installed disk allocation is not runtime memory or downloadable bytes.

## Rubric and implementation direction

| Criterion / program weight | Keep existing | Raw fast-xml compatibility adapter | Borrowed-output translation |
|---|---|---|---|
| Existing behavior fit30% | exact current implementation |11/18 new full-output parity |4/18 new full-output parity |
| Integration/migration effort25% | zero | additional semantics or versioned digest migration | lost raw information requires extra parsing/policy change |
| Custom code avoided20% | retains maintained feed normalizer | adds local normalization/compatibility fork | small mapper but incomplete |
| Maintenance15% | two pinned upstream packages already used | one parser plus owned feed semantics/attribution | borrowed module plus divergent legacy policies |
| Resource10% |2288KiB extra selected package allocation | possible disk saving, runtime unknown | same possible saving, runtime unknown |

Judgment ratings below use the program's0–5 scale, with5 meaning the strongest
fit/least additional work/most custom code avoided for this **unchanged legacy
contract**. They are ordinal assessments, not measured percentages or estimates
of all possible feed compatibility. Ranges reflect unimplemented repair scope.

| Criterion | Keep existing | Raw fast-xml compatibility adapter | Borrowed-output translation |
|---|---:|---:|---:|
| Existing behavior fit30% |5|2–3|1–2|
| Integration/migration effort25% |5|2–3|1–2|
| Custom code avoided20% |5|2–3|2–3|
| Maintenance15% |Unknown|Unknown|Unknown|
| Resource10% |Unknown|Unknown|Unknown|

Fit5 reflects keeping the exact incumbent, not certifying its correctness on every
feed. The adapted contender's11/18 new matches and seven content/error changes
support2–3; the translated contender's4/18 and lost raw information support1–2.
Effort5 means no parser migration; the alternatives need compatibility repairs or
explicit digest-version changes, with the translation approach additionally unable
to recover several original fields from its output alone. Custom-code5 means adding
no local normalization implementation. Both alternatives merit2–3 because their
small current adapters are concrete, but additional compatibility code is unbuilt;
the raw adapter reuses actual XML/entity packages, while translation reuses more
upstream behavior but still needs policy repairs.

Maintenance remainsUnknown: the ownership differences are source-evidenced, but
ongoing upstream update and repair cost was not measured. Resource remainsUnknown:
the exact installed-allocation difference above does not establish comparative
runtime memory, latency or throughput. Neither unknown is scored0 or silently
omitted from a renormalized total. No weighted total is calculated.

No numerical weighted winner is fabricated from unmeasured runtime costs. The
observed compatibility burden outweighs an approximately2.23MiB installed allocation
saving for this present MVP. Retaining **maintained upstream code**, not retaining a
home-grown XML engine, is the reuse-first choice here.

Implementation packet: no parser replacement or plan/data migration. Keep both exact
package pins and their notices; keep feed decoder and borrowed collector separate.
Continue building the already-integrated article→research→review workflow. Shared
story-material translation can still be assessed independently if it removes actual
duplication without changing source-specific evidence digests.

Reopen this narrow choice for a concrete requirement: accepted new normalization
version with intentional digest migration, substantial measured resource pressure,
upstream maintained compatible feed adapter, or security/maintenance change at one
pin. Then reuse the saved two corpora, exercise the full relevant legacy/store/plan
tests against the chosen adapter, add a clean package/uninstall graph check and
compare a representative resource workload before rollout. Rollback is the original
parser import/pin before new-version evidence is persisted; later migration requires
explicit version coexistence, not rewriting historical digests.

## Evidence and failures

Command: `node --import tsx research/reuse-comparisons/f7-parser-selection-fit.ts`.
Final captured invocation exits0 and asserts11/18 and4/18 parity counts; ordinary
mismatch results remain evidence, not test failures hidden by a repair.
[Actual stdout/exit receipt](f7-parser-selection-evidence.json) records the selected
pins, reviewed adapter hash, complete-output comparison hashes and compact field
differences. The initial invocation succeeded but returned too much output for the
tool's display budget; result receipt parsing failed on its truncation warning.
Only output formatting was narrowed, then the same corpus ran again with unchanged
candidate logic and recorded results. No initial output-completeness claim is made.
No downloads or temporary roots were created, so no cleanup/dependency removal was
needed. This closes the narrow current parser choice subject to independent review,
not all F7 workflows, host/live acceptance or universal feed compatibility.
