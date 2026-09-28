import type { ActionInboxItemV1 } from "../../operator-surfaces/v1/types";
import type { TaskAttentionPage, TaskAttentionReason } from "./task-attention-wire";

export const actionInboxKinds = ["failure", "blocked", "approval", "review", "notification", "preparation"] as const;
export type ActionInboxKind = typeof actionInboxKinds[number];

export interface ActionInboxDisplayItem {
  key: string;
  kind: ActionInboxKind;
  title: string;
  summary: string;
  href?: string;
  actionLabel: string;
  projectId?: string;
  observedAt: string;
  expiresAt?: string;
  blockedCount: number;
  deliveryState?: ActionInboxItemV1["deliveryState"];
  availableResponses: string[];
  evidenceCount: number;
}

const taskReasonLabels: Record<TaskAttentionReason, string> = {
  proposal: "Check proposal and planning status",
  assignment: "Check prepared task assignment",
  approval: "Approval requested",
  failed: "Inspect failed task",
  delivery_check: "Delivery checks unavailable",
  submission_needed: "Check approval and submission",
  delivery_pending: "Delivery pending; receipt not recorded",
  delivery_uncertain: "Transmission outcome unconfirmed; do not resend",
  delivery_rejected: "Agent reported rejected delivery; inspect task",
  orphaned: "Reconcile missing worker outcome",
  review: "Review result",
  changes_requested: "Changes requested",
  verification_blocked: "Verification needs attention",
  revision_limit_reached: "Revision limit reached",
  result_checks_unavailable: "Result or review checks incomplete",
};

const failureReasons = new Set<TaskAttentionReason>(["failed", "delivery_rejected"]);
const blockedReasons = new Set<TaskAttentionReason>(["orphaned", "delivery_pending", "delivery_uncertain", "verification_blocked"]);
const approvalReasons = new Set<TaskAttentionReason>(["approval", "submission_needed"]);
const reviewReasons = new Set<TaskAttentionReason>(["review", "changes_requested", "revision_limit_reached"]);
const notificationReasons = new Set<TaskAttentionReason>(["delivery_check", "result_checks_unavailable"]);

function taskKind(reasons: readonly TaskAttentionReason[]): ActionInboxKind {
  if (reasons.some(reason => failureReasons.has(reason))) return "failure";
  if (reasons.some(reason => blockedReasons.has(reason))) return "blocked";
  if (reasons.some(reason => approvalReasons.has(reason))) return "approval";
  if (reasons.some(reason => reviewReasons.has(reason))) return "review";
  if (reasons.some(reason => notificationReasons.has(reason))) return "notification";
  return "preparation";
}

function itemKind(item: ActionInboxItemV1): ActionInboxKind {
  if (item.kind === "failure") return "failure";
  if (item.blockedWorkItemIds.length || item.kind === "ambiguity") return "blocked";
  if (item.kind === "approval" || item.kind === "authority_expiry" || item.kind === "question") return "approval";
  if (item.kind === "review") return "review";
  return "notification";
}

function href(item: Pick<ActionInboxItemV1, "projectId" | "workItemId" | "reasonCode" | "blockedWorkItemIds">): string | undefined {
  const { projectId, workItemId } = item;
  if (projectId && workItemId && item.reasonCode === "work_batch_proposed")
    return `/projects/${encodeURIComponent(projectId)}/pipelines/${encodeURIComponent(workItemId)}`;
  if (projectId && workItemId && item.blockedWorkItemIds.includes(workItemId))
    return `/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(workItemId)}`;
  return undefined;
}

function taskHref(projectId: string, jobId: string): string {
  return `/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(jobId)}`;
}

function canonicalItem(item: ActionInboxItemV1): ActionInboxDisplayItem {
  return {
    key: `canonical:${item.id}`,
    kind: itemKind(item),
    title: item.requestedAction,
    summary: `Recorded reason: ${item.reasonCode.replaceAll("_", " ")}.`,
    href: href(item),
    actionLabel: item.reasonCode === "work_batch_proposed" ? "Open pipeline"
      : item.workItemId && item.blockedWorkItemIds.includes(item.workItemId) ? "Open task"
        : "Exact action route unavailable",
    ...(item.projectId ? { projectId: item.projectId } : {}),
    observedAt: item.createdAt,
    ...(item.expiresAt ? { expiresAt: item.expiresAt } : {}),
    blockedCount: item.blockedWorkItemIds.length,
    deliveryState: item.deliveryState,
    availableResponses: item.legalResponses.filter(response => response.available).map(response => response.label),
    evidenceCount: item.evidence.length,
  };
}

const kindRank: Record<ActionInboxKind, number> = {
  failure: 0,
  blocked: 1,
  approval: 2,
  review: 3,
  notification: 4,
  preparation: 5,
};

/** Read-only presentation over the two existing owner-attention sources. */
export function buildActionInbox(taskPages: readonly TaskAttentionPage[] = [], actionItems: readonly ActionInboxItemV1[] = []): ActionInboxDisplayItem[] {
  const tasks: ActionInboxDisplayItem[] = taskPages.flatMap(page => page.items).map(item => ({
    key: `task:${item.task.projectId}:${item.task.jobId}`,
    kind: taskKind(item.reasons),
    title: item.task.title,
    summary: `${item.ownerQuestion} ${item.reasons.map(reason => taskReasonLabels[reason]).join(" · ")}`,
    href: taskHref(item.task.projectId, item.task.jobId),
    actionLabel: "Open task",
    projectId: item.task.projectId,
    observedAt: item.task.updatedAt,
    blockedCount: item.reasons.filter(reason => blockedReasons.has(reason)).length,
    availableResponses: [],
    evidenceCount: 0,
  }));
  const canonical = actionItems.filter(item => item.state === "open").map(canonicalItem);
  return [...tasks, ...canonical].sort((left, right) => {
    const rank = kindRank[left.kind] - kindRank[right.kind];
    if (rank) return rank;
    const leftExpiry = left.expiresAt ? Date.parse(left.expiresAt) : Number.POSITIVE_INFINITY;
    const rightExpiry = right.expiresAt ? Date.parse(right.expiresAt) : Number.POSITIVE_INFINITY;
    return leftExpiry - rightExpiry || Date.parse(left.observedAt) - Date.parse(right.observedAt) || left.key.localeCompare(right.key);
  });
}
