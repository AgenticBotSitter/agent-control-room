import { PrivateProjectWorkspace } from "../../workspace";
import { decodePrivateRouteSegment } from "../../route-segment";
export const dynamic = "force-dynamic";
export default async function ProjectPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId: rawProjectId } = await params;
  const projectId = decodePrivateRouteSegment(rawProjectId);
  return <PrivateProjectWorkspace key={projectId} projectId={projectId} />;
}
