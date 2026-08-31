import { buildIdeaLabFixtureV1, CONTROL_ROOM_IDEA_ADAPTER_V1 } from "@/src/idea-lab/v1";
import { buildProjectWorkspaceSnapshotV1 } from "@/src/project-workspace/v1";

export function buildIdeaLabUiFixtureV1() {
  const ideaLab = buildIdeaLabFixtureV1();
  const project = ideaLab.promotedProject;
  const workspace = buildProjectWorkspaceSnapshotV1({
    snapshotId: `snapshot.idea-lab.${project.projectId}`,
    tenantId: project.tenantId,
    workspaceId: project.workspaceId,
    projectId: project.projectId,
    adapterId: CONTROL_ROOM_IDEA_ADAPTER_V1,
    projectType: project.projectKind,
    title: project.title,
    summary: project.summary,
    authorityMode: "control_room_native",
    generatedAt: project.updatedAt,
    extensionSections: [{ sectionId: "idea-origin", extensionKind: "idea_lab_origin", label: "Idea origin", itemCount: ideaLab.contributions.length }],
    sourceStatuses: [{
      sourceId: "source.idea-lab.fixture",
      sourceKind: "idea_lab",
      label: "Idea Lab development fixture",
      mode: "synthetic",
      state: "available",
      safeStatusCode: "injected_panel_fixture",
      checkedAt: project.updatedAt,
      lastSuccessfulAt: project.updatedAt,
      itemCount: ideaLab.contributions.length,
      grantsNetworkAuthority: false,
    }],
    activeItemCount: 0,
    waitingReviewCount: 1,
    failedItemCount: 0,
    snapshotHighWaterDigest: project.latestEventDigest,
  });
  return { ...ideaLab, workspace };
}
