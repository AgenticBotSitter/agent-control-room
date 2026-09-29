import type { ActionInboxItemV1 } from "../../operator-surfaces/v1/types";
import { actionInboxItemSchemaV1 } from "../../operator-surfaces/v1/validators";
import { notificationEnvelopeFromDecisionV1, notificationEnvelopeHasNoAuthorityV1,
  planOwnerNotificationsV1 } from "../../notifications/v1/policy";
import { OWNER_NOTIFICATIONS_CONTRACT_V1, type NotificationEnvelopeV1 } from "../../notifications/v1/types";

/** Deterministic in-product notification for a recorded proposed batch. The
 * authenticated dashboard remains the only place where an owner can decide. */
export function workBatchOwnerNotificationV1(input: { tenantId: string; projectId: string; batchId: string; createdAt: string }): {
  item: ActionInboxItemV1; envelope: NotificationEnvelopeV1 } {
  const item = actionInboxItemSchemaV1.parse({ id: `attention:work-batch:${input.batchId}`, tenantId: input.tenantId,
    projectId: input.projectId, workItemId: input.batchId, kind: "approval", state: "open",
    requestedAction: "Review proposed work batch", reasonCode: "work_batch_proposed", blockedWorkItemIds: [],
    legalResponses: [{ id: `open:${input.batchId}`, kind: "open_source", label: "Open batch review",
      requiresConfirmation: false, available: true }], evidence: [], createdAt: input.createdAt, deliveryState: "delivered" });
  const record = { recordId: item.id, recordKind: "attention" as const, projectId: input.projectId,
    title: "Proposed work batch", observedAt: input.createdAt, item };
  const plan = planOwnerNotificationsV1({ settings: { contractVersion: OWNER_NOTIFICATIONS_CONTRACT_V1,
    tenantId: input.tenantId, revision: 1, updatedAt: input.createdAt,
    projectScopes: [{ projectId: input.projectId, enabled: true, severityFloor: "routine" }], quietHours: null,
    channels: [{ channel: "in_app", available: true }] }, records: [record], acknowledgements: [], now: input.createdAt });
  const decision = plan.decisions[0];
  if (!decision || decision.state !== "notify") throw new Error("work_batch_notification_invalid");
  const envelope = notificationEnvelopeFromDecisionV1(decision);
  if (!notificationEnvelopeHasNoAuthorityV1(envelope)) throw new Error("work_batch_notification_invalid");
  return { item, envelope };
}
