import { z } from "zod";
import {
  actionInboxItemSchemaV1,
  activeWorkProjectionSchemaV1,
  ownerFocusPinSchemaV1,
  portfolioProjectProjectionSchemaV1,
  scheduleProjectionSchemaV1,
  serviceIncidentProjectionSchemaV1,
  serviceProjectionSchemaV1,
} from "../../operator-surfaces/v1/validators";
import {
  PROJECT_WORKSPACE_CATALOG_CONTRACT_V1,
  PROJECT_WORKSPACE_CATALOG_HIGH_WATER_CONTRACT_V1,
  PROJECT_WORKSPACE_CONTRACT_V1,
  PROJECT_WORKSPACE_OWNER_SESSION_CONTRACT_V1,
  PROJECT_WORKSPACE_READ_CONTRACT_V1,
} from "./types";

export const projectWorkspaceDigestSchemaV1 = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const projectWorkspaceAuthTagSchemaV1 = z.string().regex(/^hmac-sha256:[a-f0-9]{64}$/);
export const projectWorkspaceTimeSchemaV1 = z.string().datetime({ offset: true });
export const projectWorkspaceSafeIdSchemaV1 = z.string().min(3).max(180).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
export const projectWorkspaceSafeCodeSchemaV1 = z.string().min(1).max(120).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
export const projectWorkspaceLabelSchemaV1 = z.string().min(1).max(180);
export const projectWorkspaceSummarySchemaV1 = z.string().min(1).max(800);

export const projectWorkspaceRelativePathSchemaV1 = z.string().min(1).max(500).refine((value) => {
  if (!value.startsWith("/") || value.startsWith("//") || /[?#%\\]/.test(value)) return false;
  return !value.split("/").some((segment) => segment === "." || segment === "..");
}, "workspace deep link must be a safe relative path");

export const projectWorkspaceSectionSchemaV1 = z.object({
  sectionId: projectWorkspaceSafeIdSchemaV1,
  kind: z.enum(["overview", "inbox", "work", "agents", "automations", "artifacts", "reviews", "activity", "settings", "project_extension"]),
  extensionKind: projectWorkspaceSafeCodeSchemaV1.optional(),
  label: projectWorkspaceLabelSchemaV1,
  position: z.number().int().min(0).max(100),
  itemCount: z.number().int().min(0).max(1_000_000).optional(),
  attentionCount: z.number().int().min(0).max(1_000_000).optional(),
  deepLinkPath: projectWorkspaceRelativePathSchemaV1,
  presentationOnly: z.literal(true),
  grantsCommandAuthority: z.literal(false),
  grantsExecutionAuthority: z.literal(false),
}).strict().superRefine((value, context) => {
  if ((value.kind === "project_extension") !== (value.extensionKind !== undefined)) {
    context.addIssue({ code: "custom", message: "only project extensions carry an extension kind" });
  }
});

export const projectWorkspaceSourceStatusSchemaV1 = z.object({
  sourceId: projectWorkspaceSafeIdSchemaV1,
  sourceKind: projectWorkspaceSafeCodeSchemaV1,
  label: projectWorkspaceLabelSchemaV1,
  mode: z.enum(["synthetic", "configured"]),
  state: z.enum(["available", "partial", "stale", "unavailable", "disabled"]),
  safeStatusCode: projectWorkspaceSafeCodeSchemaV1,
  checkedAt: projectWorkspaceTimeSchemaV1.optional(),
  lastSuccessfulAt: projectWorkspaceTimeSchemaV1.optional(),
  itemCount: z.number().int().min(0).max(1_000_000).optional(),
  grantsNetworkAuthority: z.literal(false),
}).strict().superRefine((value, context) => {
  if (value.mode === "synthetic" && value.state === "unavailable") {
    context.addIssue({ code: "custom", message: "synthetic fixtures cannot claim a live availability failure" });
  }
  if (value.state === "available" && !value.checkedAt) {
    context.addIssue({ code: "custom", message: "available sources require a checked time" });
  }
});

export const projectWorkspaceSnapshotSchemaV1 = z.object({
  contractVersion: z.literal(PROJECT_WORKSPACE_CONTRACT_V1),
  snapshotId: projectWorkspaceSafeIdSchemaV1,
  tenantId: projectWorkspaceSafeIdSchemaV1,
  workspaceId: projectWorkspaceSafeIdSchemaV1,
  projectId: projectWorkspaceSafeIdSchemaV1,
  adapterId: projectWorkspaceSafeIdSchemaV1,
  projectType: projectWorkspaceSafeCodeSchemaV1,
  title: projectWorkspaceLabelSchemaV1,
  summary: projectWorkspaceSummarySchemaV1,
  authorityMode: z.enum(["advisory", "source_scheduled", "control_room_native"]),
  generatedAt: projectWorkspaceTimeSchemaV1,
  sections: z.array(projectWorkspaceSectionSchemaV1).min(9).max(50),
  sourceStatuses: z.array(projectWorkspaceSourceStatusSchemaV1).max(100),
  activeItemCount: z.number().int().min(0).max(1_000_000),
  waitingReviewCount: z.number().int().min(0).max(1_000_000),
  failedItemCount: z.number().int().min(0).max(1_000_000),
  snapshotHighWaterDigest: projectWorkspaceDigestSchemaV1.optional(),
  presentationOnly: z.literal(true),
  grantsApproval: z.literal(false),
  grantsNetworkAuthority: z.literal(false),
  grantsCommandAuthority: z.literal(false),
  grantsLeaseAuthority: z.literal(false),
  grantsExecutionAuthority: z.literal(false),
  snapshotDigest: projectWorkspaceDigestSchemaV1,
}).strict();

export const projectWorkspaceSnapshotInputSchemaV1 = z.object({
  snapshotId: projectWorkspaceSafeIdSchemaV1,
  tenantId: projectWorkspaceSafeIdSchemaV1,
  workspaceId: projectWorkspaceSafeIdSchemaV1,
  projectId: projectWorkspaceSafeIdSchemaV1,
  adapterId: projectWorkspaceSafeIdSchemaV1,
  projectType: projectWorkspaceSafeCodeSchemaV1,
  title: projectWorkspaceLabelSchemaV1,
  summary: projectWorkspaceSummarySchemaV1,
  authorityMode: z.enum(["advisory", "source_scheduled", "control_room_native"]),
  generatedAt: projectWorkspaceTimeSchemaV1,
  extensionSections: z.array(z.object({
    sectionId: projectWorkspaceSafeIdSchemaV1,
    extensionKind: projectWorkspaceSafeCodeSchemaV1,
    label: projectWorkspaceLabelSchemaV1,
    itemCount: z.number().int().min(0).max(1_000_000).optional(),
    attentionCount: z.number().int().min(0).max(1_000_000).optional(),
  }).strict()).max(41),
  sourceStatuses: z.array(projectWorkspaceSourceStatusSchemaV1).max(100),
  activeItemCount: z.number().int().min(0).max(1_000_000),
  waitingReviewCount: z.number().int().min(0).max(1_000_000),
  failedItemCount: z.number().int().min(0).max(1_000_000),
  snapshotHighWaterDigest: projectWorkspaceDigestSchemaV1.optional(),
}).strict();

export const projectWorkspaceReadIdentitySchemaV1 = z.object({
  tenantId: projectWorkspaceSafeIdSchemaV1,
  workspaceId: projectWorkspaceSafeIdSchemaV1,
  projectId: projectWorkspaceSafeIdSchemaV1,
}).strict();

export const authorizedProjectWorkspaceReadScopeSchemaV1 = projectWorkspaceReadIdentitySchemaV1.extend({
  actorId: projectWorkspaceSafeIdSchemaV1,
  grantedAt: projectWorkspaceTimeSchemaV1,
  expiresAt: projectWorkspaceTimeSchemaV1,
  sessionDigest: projectWorkspaceDigestSchemaV1,
  catalogId: projectWorkspaceSafeIdSchemaV1,
  catalogRevision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  catalogDigest: projectWorkspaceDigestSchemaV1,
  catalogCheckpointDigest: projectWorkspaceDigestSchemaV1,
}).strict();

export const protectedProjectCatalogEntrySchemaV1 = projectWorkspaceReadIdentitySchemaV1.extend({
  projectType: projectWorkspaceSafeCodeSchemaV1,
  state: z.enum(["active", "revoked"]),
  recordedAt: projectWorkspaceTimeSchemaV1,
}).strict();

export const protectedProjectCatalogSchemaV1 = z.object({
  contractVersion: z.literal(PROJECT_WORKSPACE_CATALOG_CONTRACT_V1),
  catalogId: projectWorkspaceSafeIdSchemaV1,
  tenantId: projectWorkspaceSafeIdSchemaV1,
  revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  previousCatalogDigest: projectWorkspaceDigestSchemaV1.nullable(),
  state: z.enum(["active", "revoked"]),
  sourceKind: z.literal("protected_server_catalog"),
  sourceIdentityDigest: projectWorkspaceDigestSchemaV1,
  recordedAt: projectWorkspaceTimeSchemaV1,
  entries: z.array(protectedProjectCatalogEntrySchemaV1).min(1).max(1_000),
  grantsApproval: z.literal(false),
  grantsNetworkAuthority: z.literal(false),
  grantsCommandAuthority: z.literal(false),
  grantsLeaseAuthority: z.literal(false),
  grantsExecutionAuthority: z.literal(false),
  catalogDigest: projectWorkspaceDigestSchemaV1,
  catalogAuthTag: projectWorkspaceAuthTagSchemaV1,
}).strict().superRefine((value, context) => {
  if ((value.revision === 1) !== (value.previousCatalogDigest === null)) {
    context.addIssue({ code: "custom", message: "catalog origin and prior digest must agree" });
  }
  if (value.entries.some((entry) => entry.tenantId !== value.tenantId || Date.parse(entry.recordedAt) > Date.parse(value.recordedAt))) {
    context.addIssue({ code: "custom", message: "catalog entries must share tenant and chronology" });
  }
  const ids = value.entries.map((entry) => entry.projectId);
  if (new Set(ids).size !== ids.length || ids.some((id, index) => index > 0 && ids[index - 1]! >= id)) {
    context.addIssue({ code: "custom", message: "catalog projects must be unique and sorted" });
  }
  if (value.state === "revoked" && value.entries.some((entry) => entry.state !== "revoked")) {
    context.addIssue({ code: "custom", message: "revoked catalog cannot expose active projects" });
  }
  if (value.state === "active" && !value.entries.some((entry) => entry.state === "active")) {
    context.addIssue({ code: "custom", message: "active catalog requires an active project" });
  }
});

export const protectedProjectCatalogHighWaterProjectSchemaV1 = projectWorkspaceReadIdentitySchemaV1.extend({
  projectType: projectWorkspaceSafeCodeSchemaV1,
  identityDigest: projectWorkspaceDigestSchemaV1,
  state: z.enum(["active", "revoked"]),
}).strict();

export const protectedProjectCatalogHighWaterSchemaV1 = z.object({
  contractVersion: z.literal(PROJECT_WORKSPACE_CATALOG_HIGH_WATER_CONTRACT_V1),
  checkpointId: projectWorkspaceSafeIdSchemaV1,
  catalogId: projectWorkspaceSafeIdSchemaV1,
  tenantId: projectWorkspaceSafeIdSchemaV1,
  revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  catalogDigest: projectWorkspaceDigestSchemaV1,
  catalogState: z.enum(["active", "revoked"]),
  sourceIdentityDigest: projectWorkspaceDigestSchemaV1,
  projects: z.array(protectedProjectCatalogHighWaterProjectSchemaV1).min(1).max(1_000),
  recordedAt: projectWorkspaceTimeSchemaV1,
  previousCheckpointDigest: projectWorkspaceDigestSchemaV1.nullable(),
  checkpointDigest: projectWorkspaceDigestSchemaV1,
  checkpointAuthTag: projectWorkspaceAuthTagSchemaV1,
}).strict().superRefine((value, context) => {
  if ((value.revision === 1) !== (value.previousCheckpointDigest === null)) {
    context.addIssue({ code: "custom", message: "checkpoint origin and prior digest must agree" });
  }
  const ids = value.projects.map((entry) => entry.projectId);
  if (new Set(ids).size !== ids.length || ids.some((id, index) => index > 0 && ids[index - 1]! >= id)
    || value.projects.some((entry) => entry.tenantId !== value.tenantId)) {
    context.addIssue({ code: "custom", message: "checkpoint projects must be unique, sorted, and tenant-bound" });
  }
  if (value.catalogState === "revoked" && value.projects.some((entry) => entry.state !== "revoked")) {
    context.addIssue({ code: "custom", message: "revoked checkpoint cannot retain active projects" });
  }
});

export const projectWorkspaceVerifiedOwnerSessionSchemaV1 = z.object({
  contractVersion: z.literal(PROJECT_WORKSPACE_OWNER_SESSION_CONTRACT_V1),
  tenantId: projectWorkspaceSafeIdSchemaV1,
  provider: projectWorkspaceSafeCodeSchemaV1,
  subject: z.string().min(1).max(320).refine((value) => !/[\r\n]/.test(value), "session subject must be one line"),
  sessionIdDigest: projectWorkspaceDigestSchemaV1,
  authenticatedAt: projectWorkspaceTimeSchemaV1,
  expiresAt: projectWorkspaceTimeSchemaV1,
  readOnly: z.literal(true),
  grantsApproval: z.literal(false),
  grantsNetworkAuthority: z.literal(false),
  grantsCommandAuthority: z.literal(false),
  grantsLeaseAuthority: z.literal(false),
  grantsExecutionAuthority: z.literal(false),
  sessionDigest: projectWorkspaceDigestSchemaV1,
}).strict();

export const projectWorkspaceReadModelSchemaV1 = z.object({
  contractVersion: z.literal(PROJECT_WORKSPACE_READ_CONTRACT_V1),
  tenantId: projectWorkspaceSafeIdSchemaV1,
  workspaceId: projectWorkspaceSafeIdSchemaV1,
  projectId: projectWorkspaceSafeIdSchemaV1,
  sourceMode: z.literal("protected_operator_surface"),
  freshness: z.enum(["current", "stale"]),
  safeStatusCode: z.enum(["protected_read_current", "protected_read_stale"]),
  readAt: projectWorkspaceTimeSchemaV1,
  sourceGeneratedAt: projectWorkspaceTimeSchemaV1,
  portfolio: portfolioProjectProjectionSchemaV1.strict(),
  activeWork: z.array(activeWorkProjectionSchemaV1.strict()).max(1_000),
  services: z.array(serviceProjectionSchemaV1.strict()).max(1_000),
  schedules: z.array(scheduleProjectionSchemaV1.strict()).max(1_000),
  serviceIncidents: z.array(serviceIncidentProjectionSchemaV1.strict()).max(1_000),
  actionInbox: z.array(actionInboxItemSchemaV1.strict()).max(1_000),
  ownerFocus: z.array(ownerFocusPinSchemaV1.strict()).max(100),
  presentationOnly: z.literal(true),
  grantsApproval: z.literal(false),
  grantsNetworkAuthority: z.literal(false),
  grantsCommandAuthority: z.literal(false),
  grantsLeaseAuthority: z.literal(false),
  grantsExecutionAuthority: z.literal(false),
  readDigest: projectWorkspaceDigestSchemaV1,
}).strict().superRefine((value, context) => {
  const expectedStatus = value.freshness === "current" ? "protected_read_current" : "protected_read_stale";
  if (value.safeStatusCode !== expectedStatus) context.addIssue({ code: "custom", message: "freshness and status must agree" });
  if (value.portfolio.projectId !== value.projectId
    || value.activeWork.some((item) => item.projectId !== value.projectId)
    || value.services.some((item) => item.projectId !== value.projectId)
    || value.schedules.some((item) => item.projectId !== value.projectId)
    || value.actionInbox.some((item) => item.tenantId !== value.tenantId || item.projectId !== value.projectId)
    || value.ownerFocus.some((item) => item.tenantId !== value.tenantId || item.projectId !== value.projectId)) {
    context.addIssue({ code: "custom", message: "project read records must share the exact scope" });
  }
  const serviceIds = new Set(value.services.map((item) => item.serviceId));
  if (value.serviceIncidents.some((item) => !serviceIds.has(item.serviceId))) {
    context.addIssue({ code: "custom", message: "incidents require a project service" });
  }
  if (value.schedules.some((item) => item.targetType === "service_check" && !serviceIds.has(item.targetId))) {
    context.addIssue({ code: "custom", message: "service schedules require a project service" });
  }
  const incidentIds = new Set(value.serviceIncidents.map((item) => item.id));
  if (value.actionInbox.some((item) => item.evidence.some((evidence) => evidence.kind === "incident" && !incidentIds.has(evidence.id)))) {
    context.addIssue({ code: "custom", message: "incident evidence must reference a project incident" });
  }
  const waitingApprovalCount = value.activeWork.filter((item) => item.state === "waiting_approval").length;
  if (value.activeWork.length > value.portfolio.activeJobCount || waitingApprovalCount > value.portfolio.waitingApprovalJobCount) {
    context.addIssue({ code: "custom", message: "project work counts cannot exceed portfolio counts" });
  }
  const age = Date.parse(value.readAt) - Date.parse(value.sourceGeneratedAt);
  if (age < 0 || (value.freshness === "current" && age > 300_000) || (value.freshness === "stale" && age <= 300_000)) {
    context.addIssue({ code: "custom", message: "read freshness is invalid" });
  }
});
