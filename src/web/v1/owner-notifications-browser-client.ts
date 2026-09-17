import { fetchOperatorSurfaceSnapshotV1 } from "../../operator-surfaces/v1/http-client";
import type { OperatorSurfaceSnapshotV1 } from "../../operator-surfaces/v1/types";
import { planOwnerNotificationsV1 } from "../../notifications/v1/policy";
import { OWNER_NOTIFICATIONS_CONTRACT_V1 } from "../../notifications/v1/types";
import type { NotificationPlanV1, NotificationSourceRecordV1, OwnerNotificationSettingsV1 } from "../../notifications/v1/types";

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
export interface OwnerNotificationsViewV1 {
  state: "available" | "unavailable";
  settings: OwnerNotificationSettingsV1;
  plan: NotificationPlanV1;
}

/** Presentation default only: not a saved policy, delivery attempt or acknowledgement. */
function defaultSettings(snapshot?: OperatorSurfaceSnapshotV1): OwnerNotificationSettingsV1 {
  const projectIds = new Set([
    ...(snapshot?.portfolio.map(project => project.projectId) ?? []),
    ...(snapshot?.actionInbox.flatMap(item => item.projectId === undefined ? [] : [item.projectId]) ?? []),
  ]);
  return {
    contractVersion: OWNER_NOTIFICATIONS_CONTRACT_V1,
    tenantId: snapshot?.tenantId ?? "unavailable",
    revision: 0,
    // Epoch is a placeholder for the unsaved default, never a source observation.
    updatedAt: snapshot?.generatedAt ?? "1970-01-01T00:00:00.000Z",
    projectScopes: [...projectIds].sort().map(projectId => ({ projectId, enabled: true, severityFloor: "routine" })),
    quietHours: null,
    channels: [{ channel: "in_app", available: true },
      { channel: "email", available: false, unavailableReasonCode: "external_not_sent", unavailableReasonText: "Not sent by this read-only panel." },
      { channel: "push", available: false, unavailableReasonCode: "external_not_sent", unavailableReasonText: "Not sent by this read-only panel." }],
  };
}

export function unavailableOwnerNotificationsV1(): OwnerNotificationsViewV1 {
  const settings = defaultSettings();
  const records: NotificationSourceRecordV1[] = [{ recordKind: "missing", recordId: "operator-surface",
    title: "Operator surface unavailable", sourceLabel: "owner attention and service incidents", observedAt: settings.updatedAt }];
  return { state: "unavailable", settings,
    plan: planOwnerNotificationsV1({ settings, records, acknowledgements: [], now: settings.updatedAt }) };
}

/** Reuse only the authenticated reader and existing planner. No write or delivery path. */
export async function readOwnerNotificationsV1(fetcher?: FetchLike): Promise<OwnerNotificationsViewV1> {
  const read = await fetchOperatorSurfaceSnapshotV1(fetcher);
  if (read.state !== "available") return unavailableOwnerNotificationsV1();
  const { snapshot } = read;
  const settings = defaultSettings(snapshot);
  const records: NotificationSourceRecordV1[] = [
    ...snapshot.actionInbox.map(item => ({ recordKind: "attention" as const, recordId: item.id,
      projectId: item.projectId, title: item.requestedAction, observedAt: item.createdAt, item })),
    // Incident projections have no project id: keep them tenant-wide, never guess one.
    ...snapshot.serviceIncidents.map(incident => ({ recordKind: "service_incident" as const, recordId: incident.id,
      title: incident.serviceId, observedAt: incident.lastObservedAt, incident })),
  ];
  return { state: "available", settings,
    plan: planOwnerNotificationsV1({ settings, records, acknowledgements: [], now: snapshot.generatedAt }) };
}
