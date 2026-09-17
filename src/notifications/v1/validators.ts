import { z } from "zod";
import { jobStates } from "../../domain/v1/types";
import { actionInboxItemSchemaV1, serviceIncidentProjectionSchemaV1 } from "../../operator-surfaces/v1/validators";
import {
  OWNER_NOTIFICATIONS_CONTRACT_V1,
  notificationChannels,
  notificationDecisionStates,
  notificationNeedKinds,
  notificationReasonCodes,
  notificationSeverities,
} from "./types";

const safeId = z.string().min(3).max(180).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
const isoDate = z.string().datetime({ offset: true });
const localTime = z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/);
const oneLine = z.string().min(1).max(600).refine((value) => !/[\r\n]/.test(value), "must be one line");

export const notificationChannelAvailabilitySchemaV1 = z.object({
  channel: z.enum(notificationChannels),
  available: z.boolean(),
  unavailableReasonCode: safeId.optional(),
  unavailableReasonText: z.string().min(1).max(240).optional(),
}).superRefine((value, context) => {
  if (value.available && value.unavailableReasonCode) context.addIssue({ code: "custom", message: "an available channel cannot carry an unavailable reason" });
  if (!value.available && !value.unavailableReasonCode) context.addIssue({ code: "custom", message: "an unavailable channel requires a safe reason" });
  if (value.available && value.channel !== "in_app") context.addIssue({ code: "custom", message: "only the in-product channel can be available; external channels are declared, never sent" });
});

export const notificationQuietHoursSchemaV1 = z.object({
  timezone: z.string().min(1).max(80),
  startLocalTime: localTime,
  endLocalTime: localTime,
  appliesTo: z.array(z.enum(notificationSeverities)).min(1).max(3),
}).superRefine((value, context) => {
  if (value.startLocalTime === value.endLocalTime) context.addIssue({ code: "custom", message: "quiet hours must span a non-empty window" });
  if (new Set(value.appliesTo).size !== value.appliesTo.length) context.addIssue({ code: "custom", message: "quiet-hour severities must be unique" });
});

export const notificationProjectScopeSchemaV1 = z.object({
  projectId: safeId,
  enabled: z.boolean(),
  severityFloor: z.enum(notificationSeverities),
});

export const ownerNotificationSettingsSchemaV1 = z.object({
  contractVersion: z.literal(OWNER_NOTIFICATIONS_CONTRACT_V1),
  tenantId: safeId,
  revision: z.number().int().min(0),
  updatedAt: isoDate,
  projectScopes: z.array(notificationProjectScopeSchemaV1).max(200),
  quietHours: notificationQuietHoursSchemaV1.nullable(),
  channels: z.array(notificationChannelAvailabilitySchemaV1).min(1).max(3),
}).superRefine((value, context) => {
  const projects = value.projectScopes.map((scope) => scope.projectId);
  if (new Set(projects).size !== projects.length) context.addIssue({ code: "custom", message: "project scopes must be unique" });
  const channels = value.channels.map((channel) => channel.channel);
  if (new Set(channels).size !== channels.length) context.addIssue({ code: "custom", message: "channels must be unique" });
  if (!channels.includes("in_app")) context.addIssue({ code: "custom", message: "the in-product channel must be declared" });
  if (!value.channels.some((channel) => channel.available)) context.addIssue({ code: "custom", message: "at least one channel state must be recorded; silence is not an availability state" });
});

export const notificationSourceRecordSchemaV1 = z.discriminatedUnion("recordKind", [
  z.object({
    recordId: safeId, recordKind: z.literal("attention"), projectId: safeId.optional(),
    title: oneLine, observedAt: isoDate, item: actionInboxItemSchemaV1,
  }),
  z.object({
    recordId: safeId, recordKind: z.literal("work_outcome"), projectId: safeId,
    title: oneLine, observedAt: isoDate, jobId: safeId, state: z.enum(jobStates),
  }),
  z.object({
    recordId: safeId, recordKind: z.literal("service_incident"), projectId: safeId.optional(),
    title: oneLine, observedAt: isoDate, incident: serviceIncidentProjectionSchemaV1,
  }),
  z.object({
    recordId: safeId, recordKind: z.literal("missing"), projectId: safeId.optional(),
    title: oneLine, observedAt: isoDate, sourceLabel: oneLine.max(160),
  }),
]);

export const notificationDecisionSchemaV1 = z.object({
  key: z.string().min(3).max(400),
  recordId: safeId,
  recordKind: z.enum(["attention", "work_outcome", "service_incident", "missing"]),
  projectId: safeId.optional(),
  needKind: z.enum(notificationNeedKinds),
  severity: z.enum(notificationSeverities),
  state: z.enum(notificationDecisionStates),
  reasonCode: z.enum(notificationReasonCodes),
  channel: z.enum(notificationChannels),
  title: oneLine.max(160),
  summary: oneLine.max(600),
  observedAt: isoDate.optional(),
  mayAct: z.literal(false),
});

export const notificationEnvelopeSchemaV1 = z.object({
  contractVersion: z.literal(OWNER_NOTIFICATIONS_CONTRACT_V1),
  key: z.string().min(3).max(400),
  recordId: safeId,
  recordKind: z.enum(["attention", "work_outcome", "service_incident", "missing"]),
  projectId: safeId.optional(),
  needKind: z.enum(notificationNeedKinds),
  severity: z.enum(notificationSeverities),
  channel: z.literal("in_app"),
  title: oneLine.max(160),
  summary: oneLine.max(600),
  observedAt: isoDate.optional(),
  authority: z.literal("none"),
  actions: z.array(z.never()).max(0),
}).strict();

export const notificationAcknowledgementSchemaV1 = z.object({
  key: z.string().min(3).max(400),
  deliveryState: z.enum(["reserved", "delivered", "delivery_unknown", "refused"]),
  observedAt: isoDate,
});