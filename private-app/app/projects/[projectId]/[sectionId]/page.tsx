import { PrivateProjectWorkspace } from "../../../workspace";
import { decodePrivateRouteSegment } from "../../../route-segment";
export const dynamic = "force-dynamic";
export default async function ProjectSection({ params }: { params: Promise<{ projectId: string; sectionId: string }> }) {
  const { projectId: rawProjectId, sectionId: rawSectionId } = await params;
  const projectId = decodePrivateRouteSegment(rawProjectId), sectionId = decodePrivateRouteSegment(rawSectionId);
  return <PrivateProjectWorkspace key={projectId} projectId={projectId} section={sectionId} />;
}
