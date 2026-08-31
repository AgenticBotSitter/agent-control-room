import { projects, blockers, workItems } from "@/src/fixtures/data";
import { buildProjectWorkspaceSnapshotV1, type ProjectWorkspaceSnapshotV1 } from "@/src/project-workspace/v1";
import { ABS_NEWS_PROJECT_ID_V1, buildAbsNewsSyntheticWorkspaceV1 } from "@/src/project-adapters/abs-news/v1";
import { WAYFARER_PRESENTATION_PROJECT_ID_V1, buildWayfarerWorkspaceViewV1 } from "@/src/project-adapters/wayfarer/v1";
import { sha256Digest } from "@/src/security";

export function buildProjectWorkspaceUiFixtureV1(projectId: string): ProjectWorkspaceSnapshotV1 | undefined {
  if (projectId === ABS_NEWS_PROJECT_ID_V1) return buildAbsNewsSyntheticWorkspaceV1().workspace;

  const project = projects.find((candidate) => candidate.id === projectId);
  if (!project) return undefined;
  const projectWork = workItems.filter((item) => item.source.projectId === projectId);
  const projectBlockers = blockers.filter((item) => item.source.projectId === projectId);
  if (projectId === WAYFARER_PRESENTATION_PROJECT_ID_V1) {
    const source = buildWayfarerWorkspaceViewV1().workspace;
    return buildProjectWorkspaceSnapshotV1({
      snapshotId: `snapshot.project-workspace.${projectId}`,
      tenantId: source.tenantId,
      workspaceId: project.source.workspaceId,
      projectId,
      adapterId: project.source.adapterId,
      projectType: project.source.recordType,
      title: project.title,
      summary: project.description,
      authorityMode: project.authorityMode,
      generatedAt: source.generatedAt,
      extensionSections: source.sections.slice(9).map((section) => ({
        sectionId: section.sectionId,
        extensionKind: section.extensionKind ?? "wayfarer_extension",
        label: section.label,
        ...(section.itemCount !== undefined ? { itemCount: section.itemCount } : {}),
        ...(section.attentionCount !== undefined ? { attentionCount: section.attentionCount } : {}),
      })),
      sourceStatuses: source.sourceStatuses,
      activeItemCount: projectWork.filter((item) => item.normalizedState === "running").length,
      waitingReviewCount: projectWork.filter((item) => item.normalizedState === "review" || item.normalizedState === "waiting").length,
      failedItemCount: projectWork.filter((item) => item.normalizedState === "failed").length,
      ...(source.snapshotHighWaterDigest ? { snapshotHighWaterDigest: source.snapshotHighWaterDigest } : {}),
    });
  }
  return buildProjectWorkspaceSnapshotV1({
    snapshotId: `snapshot.project-workspace.${projectId}`,
    tenantId: "tenant.owner",
    workspaceId: project.source.workspaceId,
    projectId,
    adapterId: project.source.adapterId,
    projectType: project.source.recordType,
    title: project.title,
    summary: project.description,
    authorityMode: project.authorityMode,
    generatedAt: project.source.observedAt,
    extensionSections: [],
    sourceStatuses: [{
      sourceId: `source.project-workspace.${project.source.sourceSystem}`,
      sourceKind: project.source.sourceSystem,
      label: `${project.workspaceName} fixture`,
      mode: "synthetic",
      state: "available",
      safeStatusCode: "synthetic_fixture",
      checkedAt: project.source.observedAt,
      lastSuccessfulAt: project.source.observedAt,
      itemCount: projectWork.length,
      grantsNetworkAuthority: false,
    }],
    activeItemCount: projectWork.filter((item) => item.normalizedState === "running").length,
    waitingReviewCount: projectWork.filter((item) => item.normalizedState === "review" || item.normalizedState === "waiting").length,
    failedItemCount: projectWork.filter((item) => item.normalizedState === "failed").length,
    snapshotHighWaterDigest: sha256Digest({
      projectSourceVersion: project.source.sourceVersion,
      work: projectWork.map((item) => [item.id, item.updatedAt]),
      blockers: projectBlockers.map((item) => [item.id, item.openedAt]),
    }),
  });
}
