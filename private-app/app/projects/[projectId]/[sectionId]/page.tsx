import { PrivateProjectWorkspace, type ProjectSection as ProjectSectionName } from "../../../workspace";
import { decodePrivateRouteSegment } from "../../../route-segment";
import { notFound } from "next/navigation";
export const dynamic = "force-dynamic";
export default async function ProjectSection({ params }: { params: Promise<{ projectId: string; sectionId: string }> }) {
  const { projectId: rawProjectId, sectionId: rawSectionId } = await params;
  const projectId = decodePrivateRouteSegment(rawProjectId), sectionId = decodePrivateRouteSegment(rawSectionId);
  if (!["inbox", "agents", "automations", "settings"].includes(sectionId)) notFound();
  return <PrivateProjectWorkspace key={projectId} projectId={projectId} section={sectionId as ProjectSectionName} />;
}
