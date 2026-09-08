# Narrow reuse decisions and custom-code exceptions

2026-09-08. This register closes individual questions only. It is not the final
all-outcomes implementation plan or permission to implement or deploy candidates.
All26 outcome-level gates remain tracked separately in the comparison index.

## DR-01 — keep fixed-panel participant selection

Scope: C1's existing1–3round, up-to6participant fixed-panel ordering only.
Recommended disposition: **retain the existing small selection loop**, not the
whole custom native runtime or every Idea Lab subsystem.

Compared actual unchanged Hermes planner, explicitly adapted actual planner and
current coordinator using current stores/receipts. Twelve mapped cases and exact
contribution counts show four policy changes can preserve all18 contributions;
the unchanged mention-driven planner does not preserve later fixed-panel rounds.
Retain current bounded prompt too: candidate prompts exceed current800-character
port in several six-member cases and were not sent by the experiment.

Custom-code exception: borrowing792lines with3,005lines of imported source and a
Python boundary to replace roughly one nested-loop selection statement adds ongoing
fork/protocol work without a required current behavior gain. The327-line coordinator
is not the deletion target: it also owns markers, receipts, budgets and refusal.
Production deletion now:0. Existing official Hermes execution/room-status/peer/file
reuse remains under evaluation; this exception does not reject it.

Exit/reopen condition: accepted mention-driven, deferred-participant or dynamic
discussion behavior, or upstream configurable strict-panel/prompt semantics. In that
case prefer the tested pure Hermes planner candidate over inventing another planner,
but qualify pre-marker selection and receipt-derived persisted bindings/recovery.

Evidence: [mapped fit](f4-planner-fit.md),
[corrected receipt](f4-planner-recheck-evidence.json),
[independent review](f4-planner-independent-review.md).

## DR-02 — retain existing news reuse and both maintained parsers

Scope: already-supported feed/discovery/curation/read-to-research path, not every
future source or full article extraction feature.
Provisional recommendation: keep the actual adopted Control Center modules; no
second full collector is justified merely because another reader exists.60 checks
exercise present integration including synthetic task/result/review completion.

Parser subdecision closed for the current MVP: retain rss-parser3.13.0 in the
legacy ABS decoder and fast-xml-parser5.11.0 in borrowed discovery/sitemap modules.
The corrected raw adapter reached18/18 in its first corpus but11/18 in a second
discriminating corpus; translating actual borrowed output reached4/18. Concrete
mixed-content/date/repeated-field differences affect content/evidence digests.
Potential removal of2288KiB allocated package files does not justify owning more
feed-normalization compatibility code without a new capability or resource need.
This retains upstream implementations, not a custom XML parser. Zero product changes.

Keep both pins/notices and existing decoder/collector boundaries. Reopen for a named
normalization version/digest migration, maintained compatible adapter, material
measured resource pressure or security/maintenance change. Shared story translation
remains separately assessable; the parser decision does not close every F7 outcome.
Evidence: [selection experiment](f7-parser-selection-fit.md),
[independent selection review](f7-parser-selection-review.md).

Miniflux/FreshRSS reader interoperability and RSSHub source generation address
different responsibilities. Their current source inspections are not completed fit
comparisons or blanket rejections; required extraction/source gaps must determine
the exact common test workload. Existing content-evidence/approval mapping remains
application glue whichever collector supplies items.

Evidence: [reconciliation](f7-existing-reconciliation.md),
[new candidate screening](f7-candidates.md),
[independent review](f7-independent-review.md).

## DR-03 — native pnpm for the prepared runtime identity graph

Select installed pnpm11.19.0 `licenses list --prod --json` on a clean frozen-lock
preparation with its own complete store metadata. Actual output matches all39
required/installed-optional runtime package identities. Retain the package manager's
resolver instead of building a custom graph walker. No new production dependency,
data migration or process; the cost is existing deterministic preparation plus
bounded output normalization and checks. Product deletion:0; generic walker avoided.

Alternatives were exercised: checker4.4.2 omitted transitives on the actual app graph;
CycloneDX6.0.1 failed its npm graph read; pnpm initially failed missing store metadata
but succeeded after isolated preparation. These are scoped dispositions, not blanket
rejections on other supported graph layouts. Do not suppress candidate errors.

Full-text collection is **not selected by this decision**: the native output emitted
no licenseContents for these39 packages. Keep the separately tested bundle plugin
and copied-source provenance; finish a maintained per-package text extraction route
plus retained exceptions/NOTICE handling. No full RC10/license clearance is claimed.
Reopen graph selection for a changed package manager/lock, peers/platform/workspaces
outside this proven scope or a concrete resolution mismatch.

Evidence: [prepared comparison](f9-prepared-fit.md),
[root review](f9-prepared-review.md), [prior contenders](f9-next-fit.md).
