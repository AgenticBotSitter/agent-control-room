import { z } from "zod";
import { PROJECT_WORKSPACE_CONTRACT_V1 } from "./types";

export const projectWorkspaceDigestSchemaV1 = z.string().regex(/^sha256:[a-f0-9]{64}$/);
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
