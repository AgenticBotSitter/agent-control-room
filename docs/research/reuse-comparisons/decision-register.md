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

## DR-02 — existing news reuse stays; parser removal is pending

Scope: already-supported feed/discovery/curation/read-to-research path, not every
future source or full article extraction feature.
Provisional recommendation: keep the actual adopted Control Center modules; no
second full collector is justified merely because another reader exists.60 checks
exercise present integration including synthetic task/result/review completion.

Removal opportunity: consolidate repeated story-field translation and potentially
two parsers, but do not delete either before deciding missing-title, relative-URL,
oversize-item and persisted legacy-plan parity. Tests prove different behaviors,
not that one package is universally defective. No parser winner yet.

Miniflux/FreshRSS reader interoperability and RSSHub source generation address
different responsibilities. Their current source inspections are not completed fit
comparisons or blanket rejections; required extraction/source gaps must determine
the exact common test workload. Existing content-evidence/approval mapping remains
application glue whichever collector supplies items.

Evidence: [reconciliation](f7-existing-reconciliation.md),
[new candidate screening](f7-candidates.md),
[independent review](f7-independent-review.md).
