import { z } from "zod";
import { assertSafeProjection } from "../../contracts/v1/validators";
import {
  OPERATOR_SURFACES_CONTRACT_V1,
  attentionDeliveryStates,
  attentionKinds,
  attentionStates,
  legalResponseKinds,
} from "./types";

const safeId = z.string().min(3).max(180).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
const isoDate = z.string().datetime({ offset: true });
const safeText = z.string().min(1).max(600).refine((value) => !/[\r\n]/.test(value), "must be one line");
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);

export const attentionEvidenceReferenceSchemaV1 = z.object({
  id: safeId,
  kind: z.enum(["artifact", "verification", "audit", "incident", "service_observation"]),
  digest: digest.optional(),
  observedAt: isoDate.optional(),
});

export const legalResponseSchemaV1 = z.object({
  id: safeId,
  kind: z.enum(legalResponseKinds),
  label: safeText.max(160),
  requiresConfirmation: z.boolean(),
  available: z.boolean(),
  unavailableReasonCode: safeId.optional(),
}).superRefine((value, context) => {
  if (value.available && value.unavailableReasonCode) context.addIssue({ code: "custom", message: "available responses cannot have an unavailable reason" });
  if (!value.available && !value.unavailableReasonCode) context.addIssue({ code: "custom", message: "unavailable responses require a safe reason" });
  if (value.kind === "approve_exact_operation" && !value.requiresConfirmation) context.addIssue({ code: "custom", message: "approval always requires confirmation" });
});

export const actionInboxItemSchemaV1 = z.object({
  id: safeId,
  tenantId: safeId,
  projectId: safeId.optional(),
  workItemId: safeId.optional(),
  kind: z.enum(attentionKinds),
  state: z.enum(attentionStates),
  requestedAction: safeText.max(160),
  reasonCode: safeId,
  blockedWorkItemIds: z.array(safeId).max(100),
  legalResponses: z.array(legalResponseSchemaV1).min(1).max(12),
  evidence: z.array(attentionEvidenceReferenceSchemaV1).max(50),
  createdAt: isoDate,
  expiresAt: isoDate.optional(),
  deliveryState: z.enum(attentionDeliveryStates),
}).superRefine((value, context) => {
  if (new Set(value.legalResponses.map((response) => response.id)).size !== value.legalResponses.length) context.addIssue({ code: "custom", message: "legal response ids must be unique" });
  if (new Set(value.blockedWorkItemIds).size !== value.blockedWorkItemIds.length) context.addIssue({ code: "custom", message: "blocked work item ids must be unique" });
  if (value.expiresAt && Date.parse(value.expiresAt) < Date.parse(value.createdAt)) context.addIssue({ code: "custom", message: "expiry cannot precede creation" });
  if (value.state === "expired" && !value.expiresAt) context.addIssue({ code: "custom", message: "expired items require an expiry" });
});

export const fleetWorkerSummarySchemaV1 = z.object({
  workerId: safeId,
  platform: z.enum(["macos", "windows", "linux", "cloud"]),
  state: z.enum(["online", "idle", "busy", "draining", "degraded", "offline", "maintenance"]),
  stateReasonCode: safeId.optional(),
  lastObservedAt: isoDate,
  capacityState: z.enum(["reported", "unavailable"]),
  availableSlots: z.number().int().min(0).optional(),
  totalSlots: z.number().int().positive().optional(),
  capabilityState: z.enum(["verified", "provisional", "expired", "unavailable"]),
  telemetryState: z.enum(["fresh", "stale", "missing"]),
}).superRefine((value, context) => {
  if (value.capacityState === "reported" && (value.availableSlots === undefined || value.totalSlots === undefined)) context.addIssue({ code: "custom", message: "reported capacity requires slot counts" });
  if (value.capacityState === "unavailable" && (value.availableSlots !== undefined || value.totalSlots !== undefined)) context.addIssue({ code: "custom", message: "unavailable capacity cannot invent slot counts" });
  if (value.availableSlots !== undefined && value.totalSlots !== undefined && value.availableSlots > value.totalSlots) context.addIssue({ code: "custom", message: "available slots cannot exceed total slots" });
});

export const bottleneckProjectionSchemaV1 = z.object({
  resourceKey: safeId,
  utilizationPercent: z.number().min(0).max(100),
  blockedWorkItemIds: z.array(safeId).min(1).max(100),
  explanation: safeText,
}).refine((value) => new Set(value.blockedWorkItemIds).size === value.blockedWorkItemIds.length, "blocked work item ids must be unique");

export const serviceIncidentProjectionSchemaV1 = z.object({
  id: safeId,
  serviceId: safeId,
  severity: z.enum(["warning", "critical"]),
  state: z.enum(["open", "resolved"]),
  reasonCode: safeId,
  remedyCode: safeId,
  openedAt: isoDate,
  lastObservedAt: isoDate,
  resolvedAt: isoDate.optional(),
}).superRefine((value, context) => {
  if (Date.parse(value.lastObservedAt) < Date.parse(value.openedAt)) context.addIssue({ code: "custom", message: "incident observation cannot precede opening" });
  if (value.state === "resolved" && !value.resolvedAt) context.addIssue({ code: "custom", message: "resolved incidents require resolution time" });
  if (value.state === "open" && value.resolvedAt) context.addIssue({ code: "custom", message: "open incidents cannot have resolution time" });
});

export const activeWorkProjectionSchemaV1 = z.object({
  jobId: safeId,
  projectId: safeId,
  state: z.enum(["leased", "running", "waiting_approval"]),
  jobType: safeId,
  priority: z.number().int().min(0).max(100),
  requiredCapability: safeId,
  updatedAt: isoDate,
});

export const portfolioProjectProjectionSchemaV1 = z.object({
  projectId: safeId,
  workflowCount: z.number().int().nonnegative().max(1_000),
  activeJobCount: z.number().int().nonnegative().max(10_000),
  waitingApprovalJobCount: z.number().int().nonnegative().max(10_000),
  failedJobCount: z.number().int().nonnegative().max(10_000),
  lastActivityAt: isoDate,
}).superRefine((value, context) => {
  if (value.waitingApprovalJobCount > value.activeJobCount) context.addIssue({ code: "custom", message: "waiting approval cannot exceed active work" });
});

export const serviceProjectionSchemaV1 = z.object({
  serviceId: safeId,
  projectId: safeId,
  serviceType: safeId,
  state: z.enum(["active", "degraded", "paused", "failed", "retired"]),
  statusCode: safeId.optional(),
  lastObservedAt: isoDate.optional(),
  lastHealthyAt: isoDate.optional(),
});

export const scheduleProjectionSchemaV1 = z.object({
  scheduleId: safeId,
  projectId: safeId,
  state: z.enum(["active", "paused", "disabled"]),
  scheduleType: z.enum(["cron", "interval", "once"]),
  targetType: z.enum(["workflow", "job", "service_check"]),
  targetId: safeId,
  timezone: z.string().min(1).max(100).refine((value) => !/[\r\n]/.test(value), "timezone must be one line"),
  nextRunAt: isoDate.optional(),
  idempotencyWindowSeconds: z.number().int().positive().max(31_536_000),
});

export const ownerFocusPinSchemaV1 = z.object({
  id: safeId,
  tenantId: safeId,
  projectId: safeId,
  level: z.enum(["p0", "today"]),
  reason: safeText.max(240),
  createdAt: isoDate,
  expiresAt: isoDate.optional(),
}).refine((value) => !value.expiresAt || Date.parse(value.expiresAt) >= Date.parse(value.createdAt), "expiry cannot precede creation");

export const ownerFocusCommandSchemaV1 = z.object({
  contractVersion: z.literal(OPERATOR_SURFACES_CONTRACT_V1),
  commandId: safeId,
  tenantId: safeId,
  operation: z.enum(["set_owner_focus", "clear_owner_focus"]),
  projectId: safeId,
  idempotencyKey: z.string().min(12).max(180),
  requestedAt: isoDate,
  level: z.enum(["p0", "today"]).optional(),
  reason: safeText.max(240).optional(),
}).strict().superRefine((value, context) => {
  const setting = value.operation === "set_owner_focus";
  if (setting && (!value.level || !value.reason)) context.addIssue({ code: "custom", message: "setting focus requires a level and reason" });
  if (!setting && (value.level || value.reason)) context.addIssue({ code: "custom", message: "clearing focus cannot replace it" });
});

export const operatorSurfaceSnapshotSchemaV1 = z.object({
  contractVersion: z.literal(OPERATOR_SURFACES_CONTRACT_V1),
  tenantId: safeId,
  generatedAt: isoDate,
  fleet: z.array(fleetWorkerSummarySchemaV1).max(1_000),
  bottlenecks: z.array(bottleneckProjectionSchemaV1).max(100),
  activeWork: z.array(activeWorkProjectionSchemaV1).max(1_000),
  portfolio: z.array(portfolioProjectProjectionSchemaV1).max(1_000),
  services: z.array(serviceProjectionSchemaV1).max(1_000),
  schedules: z.array(scheduleProjectionSchemaV1).max(1_000),
  serviceIncidents: z.array(serviceIncidentProjectionSchemaV1).max(1_000),
  actionInbox: z.array(actionInboxItemSchemaV1).max(1_000),
  ownerFocus: z.array(ownerFocusPinSchemaV1).max(100),
}).superRefine((value, context) => {
  for (const [name, ids] of [
    ["fleet", value.fleet.map((worker) => worker.workerId)],
    ["active work", value.activeWork.map((work) => work.jobId)],
    ["portfolio", value.portfolio.map((project) => project.projectId)],
    ["services", value.services.map((service) => service.serviceId)],
    ["schedules", value.schedules.map((schedule) => schedule.scheduleId)],
    ["service incidents", value.serviceIncidents.map((incident) => incident.id)],
    ["action inbox", value.actionInbox.map((item) => item.id)],
    ["owner focus", value.ownerFocus.map((pin) => pin.id)],
  ] as const) if (new Set(ids).size !== ids.length) context.addIssue({ code: "custom", message: `${name} ids must be unique` });
  if (value.actionInbox.some((item) => item.tenantId !== value.tenantId) || value.ownerFocus.some((pin) => pin.tenantId !== value.tenantId)) context.addIssue({ code: "custom", message: "snapshot records must be tenant-bound" });
});

/** Validates a display/command projection and rejects transcript, credential, or other unsafe material. */
export function parseOperatorSurfaceSnapshotV1(value: unknown) {
  const parsed = operatorSurfaceSnapshotSchemaV1.parse(value);
  assertSafeProjection(parsed);
  return parsed;
}
