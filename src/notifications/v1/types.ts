import type { JobState } from "../../domain/v1/types";
import type { ActionInboxItemV1, ServiceIncidentProjectionV1 } from "../../operator-surfaces/v1/types";

export const OWNER_NOTIFICATIONS_CONTRACT_V1 = "control-room-owner-notifications/v1" as const;

/** The four needs that may produce owner notification. Nothing else does. */
export const notificationNeedKinds = ["completion", "failure", "uncertainty", "owner_decision"] as const;
export type NotificationNeedKindV1 = (typeof notificationNeedKinds)[number];

export const notificationSeverities = ["routine", "notable", "urgent"] as const;
export type NotificationSeverityV1 = (typeof notificationSeverities)[number];

/**
 * `in_app` is the only channel this module can deliver on. `email` and `push`
 * exist as declared availability only: no provider, credential or external
 * message is ever created here.
 */
export const notificationChannels = ["in_app", "email", "push"] as const;
export type NotificationChannelV1 = (typeof notificationChannels)[number];

export const notificationDecisionStates = ["notify", "deduplicated", "suppressed", "unavailable"] as const;
export type NotificationDecisionStateV1 = (typeof notificationDecisionStates)[number];

export const notificationReasonCodes = [
  "new_meaningful_state",
  "unchanged_healthy_state",
  "duplicate_record",
  "restart_replay",
  "delivery_attempt_unknown",
  "quiet_hours",
  "project_not_in_scope",
  "below_project_severity_floor",
  "channel_unavailable",
  "external_channel_not_permitted",
  "missing_observation",
] as const;
export type NotificationReasonCodeV1 = (typeof notificationReasonCodes)[number];

export const notificationDeliveryStates = ["not_attempted", "reserved", "delivered", "delivery_unknown", "refused"] as const;
export type NotificationDeliveryStateV1 = (typeof notificationDeliveryStates)[number];

/**
 * A read-only view of exactly one canonical record. The view deliberately
 * carries no response options and no command: a notification describes a
 * recorded state and nothing else.
 */
export type NotificationSourceRecordV1 =
  | Readonly<{
      recordId: string;
      recordKind: "attention";
      projectId?: string;
      title: string;
      observedAt: string;
      item: ActionInboxItemV1;
    }>
  | Readonly<{
      recordId: string;
      recordKind: "work_outcome";
      projectId: string;
      title: string;
      observedAt: string;
      jobId: string;
      state: JobState;
    }>
  | Readonly<{
      recordId: string;
      recordKind: "service_incident";
      projectId?: string;
      title: string;
      observedAt: string;
      incident: ServiceIncidentProjectionV1;
    }>
  | Readonly<{
      recordId: string;
      recordKind: "missing";
      projectId?: string;
      title: string;
      observedAt: string;
      /** Which canonical source could not be read, in owner-safe wording. */
      sourceLabel: string;
    }>;

export type NotificationRecordKindV1 = NotificationSourceRecordV1["recordKind"];

export interface NotificationChannelAvailabilityV1 {
  channel: NotificationChannelV1;
  available: boolean;
  unavailableReasonCode?: string;
  /** Owner-visible wording for an unavailable channel; never a promise to try later. */
  unavailableReasonText?: string;
}

/** Quiet hours suppress the listed severities only. `urgent` is opt-in. */
export interface NotificationQuietHoursV1 {
  timezone: string;
  startLocalTime: string;
  endLocalTime: string;
  appliesTo: NotificationSeverityV1[];
}

export interface NotificationProjectScopeV1 {
  projectId: string;
  enabled: boolean;
  severityFloor: NotificationSeverityV1;
}

export interface OwnerNotificationSettingsV1 {
  contractVersion: typeof OWNER_NOTIFICATIONS_CONTRACT_V1;
  tenantId: string;
  revision: number;
  updatedAt: string;
  projectScopes: NotificationProjectScopeV1[];
  quietHours: NotificationQuietHoursV1 | null;
  channels: NotificationChannelAvailabilityV1[];
}

export interface NotificationDecisionV1 {
  /** Deterministic dedupe key: stable across repeated reads and restarts. */
  key: string;
  recordId: string;
  recordKind: NotificationRecordKindV1;
  projectId?: string;
  needKind: NotificationNeedKindV1;
  severity: NotificationSeverityV1;
  state: NotificationDecisionStateV1;
  reasonCode: NotificationReasonCodeV1;
  channel: NotificationChannelV1;
  title: string;
  summary: string;
  observedAt?: string;
  /** Literal. A notification is a description; it is never a permission. */
  mayAct: false;
}

export interface NotificationPlanV1 {
  contractVersion: typeof OWNER_NOTIFICATIONS_CONTRACT_V1;
  generatedAt: string;
  decisions: NotificationDecisionV1[];
  counts: Record<NotificationDecisionStateV1, number>;
  quietHoursActive: boolean;
  /** Keys this run would hand to a sink, in decision order. */
  deliverableKeys: string[];
}

/** A previously attempted delivery. `reserved`/`delivery_unknown` are unconfirmed. */
export interface NotificationAcknowledgementV1 {
  key: string;
  deliveryState: Exclude<NotificationDeliveryStateV1, "not_attempted">;
  observedAt: string;
}

export interface NotificationEnvelopeV1 {
  contractVersion: typeof OWNER_NOTIFICATIONS_CONTRACT_V1;
  key: string;
  recordId: string;
  recordKind: NotificationRecordKindV1;
  projectId?: string;
  needKind: NotificationNeedKindV1;
  severity: NotificationSeverityV1;
  channel: "in_app";
  title: string;
  summary: string;
  observedAt?: string;
  /** Literal. The envelope carries no approve, retry, cancel or dispatch field. */
  authority: "none";
  actions: readonly [];
}

/** The injected sink. Tests supply a recorder; the product supplies its own port. */
export interface NotificationSinkV1 {
  channel: "in_app";
  record(envelope: NotificationEnvelopeV1): Promise<{ acknowledged: boolean }>;
}

/**
 * Durable reservation record. `reserve` must return false when the key is
 * already reserved or delivered, so a crash between reserve and confirm
 * cannot produce a second notification.
 */
export interface NotificationDeliveryLedgerV1 {
  reserve(key: string, at: string): Promise<boolean>;
  confirm(key: string, outcome: "delivered" | "delivery_unknown", at: string): Promise<void>;
}

export interface NotificationDeliveryResultV1 {
  key: string;
  state: NotificationDeliveryStateV1;
  reasonCode: NotificationReasonCodeV1;
}