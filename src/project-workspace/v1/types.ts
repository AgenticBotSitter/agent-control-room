export const PROJECT_WORKSPACE_CONTRACT_V1 = "control-room-project-workspace/v1" as const;

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
