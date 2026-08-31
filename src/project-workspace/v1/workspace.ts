import { sha256Digest } from "../../security";
import { ProjectWorkspaceContractErrorV1 } from "./errors";
import { parseExactProjectWorkspaceV1 } from "./exact";
import { projectWorkspaceSnapshotInputSchemaV1, projectWorkspaceSnapshotSchemaV1 } from "./schemas";
import {
  PROJECT_WORKSPACE_CONTRACT_V1,
  PROJECT_WORKSPACE_CORE_SECTIONS_V1,
  type ProjectWorkspaceSectionV1,
  type ProjectWorkspaceSnapshotInputV1,
  type ProjectWorkspaceSnapshotV1,
} from "./types";

function unsigned(snapshot: ProjectWorkspaceSnapshotV1): Omit<ProjectWorkspaceSnapshotV1, "snapshotDigest"> {
  const { snapshotDigest: _snapshotDigest, ...material } = snapshot;
  void _snapshotDigest;
  return material;
}

function sections(input: ProjectWorkspaceSnapshotInputV1): ProjectWorkspaceSectionV1[] {
  const reserved = new Set<string>(PROJECT_WORKSPACE_CORE_SECTIONS_V1.map((section) => section.sectionId));
  const extensionIds = new Set<string>();
  for (const section of input.extensionSections) {
    if (reserved.has(section.sectionId) || extensionIds.has(section.sectionId)) throw new ProjectWorkspaceContractErrorV1("invalid_input");
    extensionIds.add(section.sectionId);
  }
  const base: ProjectWorkspaceSectionV1[] = PROJECT_WORKSPACE_CORE_SECTIONS_V1.map((section, position) => ({
    ...section,
    position,
    deepLinkPath: `/projects/${input.projectId}/${section.sectionId}`,
    presentationOnly: true,
    grantsCommandAuthority: false,
    grantsExecutionAuthority: false,
  }));
  const extensions = input.extensionSections.map((section, index): ProjectWorkspaceSectionV1 => ({
    ...section,
    kind: "project_extension",
    position: base.length + index,
    deepLinkPath: `/projects/${input.projectId}/${section.sectionId}`,
    presentationOnly: true,
    grantsCommandAuthority: false,
    grantsExecutionAuthority: false,
  }));
  return [...base, ...extensions];
}

export function buildProjectWorkspaceSnapshotV1(inputValue: unknown): ProjectWorkspaceSnapshotV1 {
  const input = parseExactProjectWorkspaceV1(projectWorkspaceSnapshotInputSchemaV1, inputValue) as ProjectWorkspaceSnapshotInputV1;
  const sourceIds = new Set<string>();
  for (const source of input.sourceStatuses) {
    if (sourceIds.has(source.sourceId)) throw new ProjectWorkspaceContractErrorV1("invalid_input");
    sourceIds.add(source.sourceId);
  }
  const material: Omit<ProjectWorkspaceSnapshotV1, "snapshotDigest"> = {
    contractVersion: PROJECT_WORKSPACE_CONTRACT_V1,
    snapshotId: input.snapshotId,
    tenantId: input.tenantId,
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    adapterId: input.adapterId,
    projectType: input.projectType,
    title: input.title,
    summary: input.summary,
    authorityMode: input.authorityMode,
    generatedAt: input.generatedAt,
    sections: sections(input),
    sourceStatuses: input.sourceStatuses,
    activeItemCount: input.activeItemCount,
    waitingReviewCount: input.waitingReviewCount,
    failedItemCount: input.failedItemCount,
    ...(input.snapshotHighWaterDigest ? { snapshotHighWaterDigest: input.snapshotHighWaterDigest } : {}),
    presentationOnly: true,
    grantsApproval: false,
    grantsNetworkAuthority: false,
    grantsCommandAuthority: false,
    grantsLeaseAuthority: false,
    grantsExecutionAuthority: false,
  };
  return parseExactProjectWorkspaceV1(projectWorkspaceSnapshotSchemaV1, { ...material, snapshotDigest: sha256Digest(material) }) as ProjectWorkspaceSnapshotV1;
}

export function parseProjectWorkspaceSnapshotV1(value: unknown): ProjectWorkspaceSnapshotV1 {
  const snapshot = parseExactProjectWorkspaceV1(projectWorkspaceSnapshotSchemaV1, value) as ProjectWorkspaceSnapshotV1;
  if (sha256Digest(unsigned(snapshot)) !== snapshot.snapshotDigest) throw new ProjectWorkspaceContractErrorV1("digest_mismatch");
  const core = snapshot.sections.slice(0, PROJECT_WORKSPACE_CORE_SECTIONS_V1.length);
  const validCore = PROJECT_WORKSPACE_CORE_SECTIONS_V1.every((expected, position) => {
    const actual = core[position];
    return actual?.sectionId === expected.sectionId && actual.kind === expected.kind && actual.label === expected.label && actual.position === position;
  });
  if (!validCore || snapshot.sections.some((section, index) => section.position !== index)) throw new ProjectWorkspaceContractErrorV1("invalid_input");
  if (new Set(snapshot.sections.map((section) => section.sectionId)).size !== snapshot.sections.length) throw new ProjectWorkspaceContractErrorV1("invalid_input");
  if (new Set(snapshot.sourceStatuses.map((source) => source.sourceId)).size !== snapshot.sourceStatuses.length) throw new ProjectWorkspaceContractErrorV1("invalid_input");
  return snapshot;
}
