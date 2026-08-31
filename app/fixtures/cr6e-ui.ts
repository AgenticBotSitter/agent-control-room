import type { ActionInboxItemV1, OwnerFocusPinV1 } from "@/src/operator-surfaces/v1/types";

/** Explicitly synthetic UI records that use the same shape as the durable CR-6E Action Inbox. */
export const cr6eActionInboxFixture: ActionInboxItemV1[] = [
  {
    id: "attention.wayfarer.preview", tenantId: "tenant:owner", projectId: "project.wayfarer.lazy-river", workItemId: "work.wayfarer.alpine-preview",
    kind: "review", state: "open", requestedAction: "Review the Alpine preview evidence", reasonCode: "preview_ready_for_review", blockedWorkItemIds: ["work.wayfarer.alpine-preview"],
    legalResponses: [
      { id: "response.wayfarer.open", kind: "open_source", label: "Open project review", requiresConfirmation: false, available: true },
      { id: "response.wayfarer.review", kind: "request_review", label: "Request independent review", requiresConfirmation: true, available: true },
    ], evidence: [{ id: "evidence.wayfarer.preview", kind: "verification", observedAt: "2026-08-22T17:12:00.000Z" }], createdAt: "2026-08-22T17:12:00.000Z", expiresAt: "2026-08-22T20:30:00.000Z", deliveryState: "delivered",
  },
  {
    id: "attention.blooms.route", tenantId: "tenant:owner", projectId: "project.blooms.content-ops", workItemId: "work.blooms.transcription",
    kind: "ambiguity", state: "open", requestedAction: "Choose a transcription fallback route", reasonCode: "preferred_route_unavailable", blockedWorkItemIds: ["work.blooms.transcription"],
    legalResponses: [
      { id: "response.blooms.open", kind: "open_source", label: "Open route comparison", requiresConfirmation: false, available: true },
      { id: "response.blooms.decision", kind: "record_decision", label: "Record route decision", requiresConfirmation: true, available: true },
    ], evidence: [{ id: "evidence.blooms.route", kind: "audit", observedAt: "2026-08-22T17:25:00.000Z" }], createdAt: "2026-08-22T17:25:00.000Z", expiresAt: "2026-08-22T18:30:00.000Z", deliveryState: "delivered",
  },
  {
    id: "attention.blooms.review", tenantId: "tenant:owner", projectId: "project.blooms.content-ops", workItemId: "work.blooms.draft-review",
    kind: "review", state: "open", requestedAction: "Review the synthetic draft record", reasonCode: "draft_review_requested", blockedWorkItemIds: ["work.blooms.draft-review"],
    legalResponses: [
      { id: "response.blooms.open-review", kind: "open_source", label: "Open protected review", requiresConfirmation: false, available: true },
      { id: "response.blooms.approve", kind: "approve_exact_operation", label: "Approve exact next operation", requiresConfirmation: true, available: false, unavailableReasonCode: "approval_not_issued" },
    ], evidence: [{ id: "evidence.blooms.draft", kind: "artifact", observedAt: "2026-08-22T17:11:00.000Z" }], createdAt: "2026-08-22T17:11:00.000Z", deliveryState: "failed",
  },
];

export const cr6eOwnerFocusFixture: OwnerFocusPinV1[] = [
  { id: "focus.wayfarer", tenantId: "tenant:owner", projectId: "project.wayfarer.lazy-river", level: "p0", reason: "Owner wants the preview review visible", createdAt: "2026-08-22T17:30:00.000Z" },
  { id: "focus.blooms", tenantId: "tenant:owner", projectId: "project.blooms.content-ops", level: "today", reason: "Resolve the route choice today", createdAt: "2026-08-22T17:30:00.000Z" },
];
