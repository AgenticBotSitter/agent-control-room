export const PROJECT_WORKSPACE_CONTRACT_V1 = "control-room-project-workspace/v1" as const;
export const PROJECT_WORKSPACE_READ_CONTRACT_V1 = "control-room-project-workspace-read/v1" as const;
export const PROJECT_WORKSPACE_CATALOG_CONTRACT_V1 = "control-room-project-workspace-catalog/v1" as const;
export const PROJECT_WORKSPACE_CATALOG_HIGH_WATER_CONTRACT_V1 = "control-room-project-workspace-catalog-high-water/v1" as const;
export const PROJECT_WORKSPACE_OWNER_SESSION_CONTRACT_V1 = "control-room-project-workspace-owner-session/v1" as const;

export const PROJECT_WORKSPACE_CORE_SECTIONS_V1 = [
  { sectionId: "overview", kind: "overview", label: "Overview" },
  { sectionId: "inbox", kind: "inbox", label: "Inbox" },
  { sectionId: "work", kind: "work", label: "Work" },
  { sectionId: "agents", kind: "agents", label: "Agents" },
  { sectionId: "automations", kind: "automations", label: "Automations" },
  { sectionId: "artifacts", kind: "artifacts", label: "Files and artifacts" },
  { sectionId: "reviews", kind: "reviews", label: "Reviews" },
  { sectionId: "activity", kind: "activity", label: "Activity" },
  { sectionId: "settings", kind: "settings", label: "Settings" },
] as const;

export type ProjectWorkspaceCoreSectionKindV1 = (typeof PROJECT_WORKSPACE_CORE_SECTIONS_V1)[number]["kind"];
export type ProjectWorkspaceAuthorityModeV1 = "advisory" | "source_scheduled" | "control_room_native";
export type ProjectWorkspaceSourceModeV1 = "synthetic" | "configured";
export type ProjectWorkspaceSourceStateV1 = "available" | "partial" | "stale" | "unavailable" | "disabled";

export interface ProjectWorkspaceSectionV1 {
  sectionId: string;
  kind: ProjectWorkspaceCoreSectionKindV1 | "project_extension";
  extensionKind?: string;
  label: string;
  position: number;
  itemCount?: number;
  attentionCount?: number;
  deepLinkPath: string;
  presentationOnly: true;
  grantsCommandAuthority: false;
  grantsExecutionAuthority: false;
}

export interface ProjectWorkspaceSourceStatusV1 {
  sourceId: string;
  sourceKind: string;
  label: string;
  mode: ProjectWorkspaceSourceModeV1;
  state: ProjectWorkspaceSourceStateV1;
  safeStatusCode: string;
  checkedAt?: string;
  lastSuccessfulAt?: string;
  itemCount?: number;
  grantsNetworkAuthority: false;
}

export interface ProjectWorkspaceSnapshotV1 {
  contractVersion: typeof PROJECT_WORKSPACE_CONTRACT_V1;
  snapshotId: string;
  tenantId: string;
  workspaceId: string;
  projectId: string;
  adapterId: string;
  projectType: string;
  title: string;
  summary: string;
  authorityMode: ProjectWorkspaceAuthorityModeV1;
  generatedAt: string;
  sections: ProjectWorkspaceSectionV1[];
  sourceStatuses: ProjectWorkspaceSourceStatusV1[];
  activeItemCount: number;
  waitingReviewCount: number;
  failedItemCount: number;
  snapshotHighWaterDigest?: string;
  presentationOnly: true;
  grantsApproval: false;
  grantsNetworkAuthority: false;
  grantsCommandAuthority: false;
  grantsLeaseAuthority: false;
  grantsExecutionAuthority: false;
  snapshotDigest: string;
}

export interface ProjectWorkspaceExtensionSectionInputV1 {
  sectionId: string;
  extensionKind: string;
  label: string;
  itemCount?: number;
  attentionCount?: number;
}

export interface ProjectWorkspaceSnapshotInputV1 {
  snapshotId: string;
  tenantId: string;
  workspaceId: string;
  projectId: string;
  adapterId: string;
  projectType: string;
  title: string;
  summary: string;
  authorityMode: ProjectWorkspaceAuthorityModeV1;
  generatedAt: string;
  extensionSections: ProjectWorkspaceExtensionSectionInputV1[];
  sourceStatuses: ProjectWorkspaceSourceStatusV1[];
  activeItemCount: number;
  waitingReviewCount: number;
  failedItemCount: number;
  snapshotHighWaterDigest?: string;
}

export interface ProjectWorkspaceReadIdentityV1 {
  tenantId: string;
  workspaceId: string;
  projectId: string;
}

export interface AuthorizedProjectWorkspaceReadScopeV1 extends ProjectWorkspaceReadIdentityV1 {
  actorId: string;
  grantedAt: string;
  expiresAt: string;
  sessionDigest: string;
  catalogId: string;
  catalogRevision: number;
  catalogDigest: string;
  catalogCheckpointDigest: string;
}

export interface ProtectedProjectCatalogEntryV1 extends ProjectWorkspaceReadIdentityV1 {
  projectType: string;
  state: "active" | "revoked";
  recordedAt: string;
}

export interface ProtectedProjectCatalogV1 {
  contractVersion: typeof PROJECT_WORKSPACE_CATALOG_CONTRACT_V1;
  catalogId: string;
  tenantId: string;
  revision: number;
  previousCatalogDigest: string | null;
  state: "active" | "revoked";
  sourceKind: "protected_server_catalog";
  sourceIdentityDigest: string;
  recordedAt: string;
  entries: ProtectedProjectCatalogEntryV1[];
  grantsApproval: false;
  grantsNetworkAuthority: false;
  grantsCommandAuthority: false;
  grantsLeaseAuthority: false;
  grantsExecutionAuthority: false;
  catalogDigest: string;
  catalogAuthTag: string;
}

export interface ProtectedProjectCatalogHighWaterProjectV1 extends ProjectWorkspaceReadIdentityV1 {
  projectType: string;
  identityDigest: string;
  state: "active" | "revoked";
}

export interface ProtectedProjectCatalogHighWaterV1 {
  contractVersion: typeof PROJECT_WORKSPACE_CATALOG_HIGH_WATER_CONTRACT_V1;
  checkpointId: string;
  catalogId: string;
  tenantId: string;
  revision: number;
  catalogDigest: string;
  catalogState: "active" | "revoked";
  sourceIdentityDigest: string;
  projects: ProtectedProjectCatalogHighWaterProjectV1[];
  recordedAt: string;
  previousCheckpointDigest: string | null;
  checkpointDigest: string;
  checkpointAuthTag: string;
}

export interface ProjectWorkspaceVerifiedOwnerSessionV1 {
  contractVersion: typeof PROJECT_WORKSPACE_OWNER_SESSION_CONTRACT_V1;
  tenantId: string;
  provider: string;
  subject: string;
  sessionIdDigest: string;
  authenticatedAt: string;
  expiresAt: string;
  readOnly: true;
  grantsApproval: false;
  grantsNetworkAuthority: false;
  grantsCommandAuthority: false;
  grantsLeaseAuthority: false;
  grantsExecutionAuthority: false;
  sessionDigest: string;
}

export interface ProjectWorkspaceReadModelV1 extends ProjectWorkspaceReadIdentityV1 {
  contractVersion: typeof PROJECT_WORKSPACE_READ_CONTRACT_V1;
  sourceMode: "protected_operator_surface";
  freshness: "current" | "stale";
  safeStatusCode: "protected_read_current" | "protected_read_stale";
  readAt: string;
  sourceGeneratedAt: string;
  portfolio: import("../../operator-surfaces/v1").PortfolioProjectProjectionV1;
  activeWork: import("../../operator-surfaces/v1").ActiveWorkProjectionV1[];
  services: import("../../operator-surfaces/v1").ServiceProjectionV1[];
  schedules: import("../../operator-surfaces/v1").ScheduleProjectionV1[];
  serviceIncidents: import("../../operator-surfaces/v1").ServiceIncidentProjectionV1[];
  actionInbox: import("../../operator-surfaces/v1").ActionInboxItemV1[];
  ownerFocus: import("../../operator-surfaces/v1").OwnerFocusPinV1[];
  presentationOnly: true;
  grantsApproval: false;
  grantsNetworkAuthority: false;
  grantsCommandAuthority: false;
  grantsLeaseAuthority: false;
  grantsExecutionAuthority: false;
  readDigest: string;
}

export type ProjectWorkspaceReadResultV1 =
  | { state: "available"; model: ProjectWorkspaceReadModelV1 }
  | { state: "unavailable"; code: "project_not_found" | "protected_source_unavailable" };
