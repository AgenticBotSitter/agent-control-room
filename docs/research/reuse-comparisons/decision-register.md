# Narrow reuse decisions and custom-code exceptions

2026-09-08. This register closes individual questions only. It is not the final
all-outcomes implementation plan or permission to implement or deploy candidates.
All26 outcome-level gates remain tracked separately in the comparison index.

## DR-05 — synchronous maintained JWT verification

Select jsonwebtoken9.0.3 behind the current Node22 synchronous Access verifier,
with narrow adaptation for existing canonical bytes, trusted keys, claims, session
limits and frozen identity. Actual policy/project/dispatch/bootstrap/cache/rehearsal
comparisons support both candidates; jsonwebtoken avoids changing six consuming
files to async. jose6.2.12 remains viable and has fewer runtime dependencies, but its
extra awaited/precommit/freshness migration is not justified for this current server.
Retaining current Node crypto is compatible but retains standard JWT maintenance
here. Do not keep two token libraries or change login provider.

Scope: verifier module plus manifest/lock/notices, zero caller-signature edits,
no DB migration/service/upstream fork. Remove standard decode/signature work, not
application authority, key-cache policy or identity/digest semantics. TypeScript
interop, any separately required maintained typings, actual shipped import and
complete dependency notices remain implementation/release gates. Moderate overall
confidence; no runtime benchmark winner or complete security clearance claimed.

Independent challenge accepted with explicit confidence and overlapping-score
qualifications. Reopen for changed runtime/algorithm, material upstream maintenance,
measured dependency problems or broader approved async migration. Do not repeat
unchanged narrow experiments merely because owner/live qualification is still open.
Evidence, exact removal boundary, rubric, alternatives and review:
[selection](f8-jwt-selection.md), [independent review](f8-jwt-selection-review.md).

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

## DR-04 — maintained public collector for runtime original text attachments

Select `@cyclonedx/cyclonedx-library@10.2.0` public
`Contrib/License.Utils.LicenseEvidenceGatherer` for the narrow per-package original
text responsibility, paired with DR-03's native pnpm identity/path graph and the
existing four checksum-bound notice exceptions. Do not adopt the npm CLI's graph
reader or add another generic filesystem/package scanner.

Actual current-runtime fit supplies36 original attachments across35 identities;
the same collector consumes four explicitly staged retained texts byte-for-byte,
giving39 identities and40 attachments. Both type-fest originals survive. The final
viable checker4.4.2 per-path alternative executes successfully but selects one text
and normalizes it; preserving multiple originals would require more extraction and
staging. The plugin likewise selects one license text, so keep its separately tested
bundle-module discovery responsibility. Native pnpm lacks full texts; the CLI graph
failure does not invalidate this supported public library interface.

This is an engineering preservation choice, not a claim that an OR-license requires
shipping both alternatives or that checker users violate licenses. Retain original
source names/digests, exact exceptions and their unresolved source-correspondence
qualifications. The public library's default symlink following and limited filename
patterns require the reviewed filesystem port and explicit exception records, not
trust in a source comment or silent omission of missing text.

Implementation cost: one build-time package (8MiB observed installed/cache cohort,
not server RAM), no optional validator peers for this tested entry, no service,
database migration or upstream fork. Keep library Apache license/NOTICE. Preserve
existing checksum/completeness/build-binding glue; production deletion now0. Avoided
work is generic matching/attachment encoding and duplicate graph traversal, not all
attribution logic. See scoped rubric with unknown comparative performance in the
runtime fit report; no unmeasured speed advantage is claimed.

Remaining acceptance: bounded snapshot-safe filesystem reads (lstat/read alone is
not atomic), actual release/bundle/copied/asset/nested-vendor reconciliation, target
platform package variants and final reviewed output. This decision closes text-tool
selection, not RC10, legal clearance or publication. Reopen for a changed runtime
graph, required unsupported text format, material upstream change or a maintained
alternative offering the same original-text behavior with lower demonstrated cost.

Evidence: [actual runtime fit](f9-runtime-text-fit.md),
[runtime review](f9-runtime-text-review.md),
[final per-path alternative](f9-checker-path-fit.md),
[independent root review](f9-checker-path-review.md).
