# Narrow reuse decisions and custom-code exceptions

2026-09-08. This register closes individual questions only. It is not the final
all-outcomes implementation plan or permission to implement or deploy candidates.
All26 outcome-level gates remain tracked separately in the comparison index.

## DR-10 — maintained node-postgres at the existing database port

Conditionally select node-postgres8.23.0 for implementation, retaining the actual
bounded DatabaseSession, canonical transaction/precommit coupling and uncertain-outcome
quarantine. Root accepts the narrow [direction](f1-driver-selection-draft.md) and
[independent challenge](f1-driver-selection-review.md), not production readiness.

Eight value cases, actual precommit rollback and four CR queue adapter cases pass.
The public-release lifecycle composition also handles one active/queued shutdown
with zero observed pool clients/waiters and tracked checkouts before return. This
does not establish instant server cancellation, late-connect race coverage or a
production-ready adapter. Plain Pool.end alone is explicitly not the selected design.

Blanket Postgres.js string typing is rejected for global use after actual uncast
timestamp/UUID failures. Targeted semantic typing and supported custom JSON type
configuration remain viable alternatives, not falsely labeled broken; they require
caller/type-policy changes that pg avoids for the present unannotated interface.
Prefer maintained wire/type/pool code plus the necessary bounded lifecycle glue;
no custom serializer, ORM, wire protocol or new queue is selected for this problem.

No production lines removed yet. Inventory/replace existing Postgres.js runtime
consumers, declare/notice the intentional pg dependency, and test exact settings,
late/failed acquire, multiple leases, release/close races, full callers and uncertain
COMMIT reconciliation. Real PG17/current roles remain acceptance gates. No automatic
fallback between drivers or replay after uncertainty. Reopen if the concrete adapter
fails those gates or targeted Postgres.js reuse demonstrates lower total cost.

This closes a conditional implementation direction only, not RC1 engine selection,
all database verification, the 26-outcome comparison or deployment authorization.

## DR-09 — public cron-parser expansion and matching

Select the public parser/field/includesDate seam, retaining existing schedule
grammar, bounded scan and occurrence authority. Root accepts the42-case comparison
and independent review; see [selection and alternative costs](f1-calendar-selection.md).
This closes standard calculator matching selection, not queue or scheduler delivery.

## DR-08 — native Git for the initial detached checkout

Select native Git's detached-worktree operation behind the existing
`CodexWorkspaceManagerV1` identity/lease boundary, not unchanged AO Restore.
Root accepts the independently challenged narrow choice in
[workspace selection](f4-workspace-selection.md) and
[review](f4-workspace-selection-review.md), including both corrected findings.

AO's actual tested attached-branch and nested-path behavior does not satisfy this
port unchanged: requested BaseRef can differ from observed HEAD. Do not rename
that field or change application authority to make it appear compatible. Native
Git supplies the checkout operation; CR-specific execution/ownership glue is the
custom exception, not a new worktree engine. AO remains the evaluated donor for
automatic preservation/stash/merge when needed; compiled-helper packaging costs
must not be inflated into a mandatory installed Go runtime.

No concrete production port is present in the inspected scope. Detached-state
readback, concurrent preparation, failed-create/readback ownership, dirty/conflict
preservation, stale/duplicate state and restart reconciliation remain mandatory
implementation acceptance. Keeping an in-memory manager is not durable ownership.
No-loss handling is required even when automatic repair is not implemented.

Production deletion zero; no new dependency, service or schema change selected.
Integration effort remains estimated, with no measured total-cost winner. Reopen
if actual implementation requires a preservation framework, AO supplies the exact
detached/path interface, or measured adapter cost overturns this narrow choice.
This does not close all RC4 responsibilities or authorize checkout/deletion effects.

## DR-07 — default article extraction primitive

Select Readability0.6.0 with jsdom26.1.0 for the bounded Node reader integration.
This is the extraction primitive choice, not completion of the full reader,
shipping approval or a claim of best extraction quality on every publisher.
Root accepts the [independent selection synthesis](f7-extractor-selection-review.md)
and its distinction between demonstrated HTML/interface fit and unmeasured quality.

Actual common-corpus and normal-HTML tests favor this supported in-process embedding
over writing an extractor, HTML normalizer or selector engine. The bundled DOM's
well-formed-markup limitations and missing selectors rule it out for ordinary raw
HTML. Miniflux's tested small pure extractor remains viable, with real upstream
tests; its process/package integration and different output responsibilities are
extra work for the current Node app, not proof of inferior extraction quality.
Reusing the existing story title remains a legitimate alternative, not a reason
to falsely call Miniflux broken. Full Miniflux/FreshRSS readers and RSSHub source
generation have separate responsibilities, not an obligation to install a service
to obtain main-text extraction.

Keep the existing borrowed collector, parsers, summaries and canonical source links.
Summaries alone do not satisfy full-article reading. Add the selected extraction
only through a source-bound detail/evidence path that preserves project/story digest
and approved research lineage. Existing native-result capture cannot be used as an
article bucket by fabricating a completed run. Both extractors retain unsafe HTML
attributes; plain text is the initial presentation direction, not an implicit
sanitization guarantee or authorization to republish copyrighted articles.

No upstream fork, added service or production deletion is selected. Add only the
chosen package boundary and project-specific retrieval/detail glue during the
implementation phase; do not build a general artifact or parsing framework.
Full transitive/file notices (including differently licensed bundled subfiles),
bounded DOM memory/time/output, representative publisher quality, actual reader
storage/rendering/fallback and source-to-task acceptance remain explicit gates.
Cold fixture RSS is not a production benchmark; no cross-runtime memory winner.

Reopen if the actual integration fails a required quality/resource/dependency
constraint or an existing external reader supplies a newly required capability.
Do not repeat unchanged primitive tests before attempting that real integration.

## DR-06 — preserve task authority; reuse notification routing only for a named gap

Do not replace canonical CR task/attempt/receipt state with unchanged Maestro local
delivery. Actual deliver/wake-chain/queue execution accepts a changed body under
the same ID, overwrites one inbox record and queues two wakes. Its verified wake
status is not an exact message/digest/attempt acknowledgement. Retaining current
immutable state is a responsibility-specific exception, not rejection of Maestro
or justification for another custom messaging framework.

Compared alternatives: current canonical dispatch/journals; actual Maestro local
delivery; previously evaluated Hermes participant/room state (with its separate
zero-tool policy mismatch). Native agent execution remains under RC2; none of these
local message observations alone qualifies it. Existing direct participant paths
remain the MVP route pending their own complete lifecycle qualification.

No notification framework or new service is selected now. For a concrete future
heterogeneous notification gap, prefer Maestro's tested ordered adapters and
unavailable/sent/deferred/confirmed distinctions as the first reuse candidate.
Reopen on a named required channel or upstream exact-message immutable receipt
contract; then test ingress authentication, digest replay, restart and actual
transport before adoption. No whole-service cost or licence clearance is inferred.

Production deletion0; no DB migration, dependencies or service added by this choice.
Evidence: [actual delivery fit](f4-delivery-fit.md),
[root review](f4-delivery-review.md). The broader RC4 packet remains open.

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
