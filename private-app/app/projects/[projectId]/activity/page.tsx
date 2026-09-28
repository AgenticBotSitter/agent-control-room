import { ProjectActivityTimelineV1 } from "../../../project-activity-timeline";
import { decodePrivateRouteSegment } from "../../../route-segment";

export const dynamic = "force-dynamic";
export const metadata = { title: "Project activity · Control Room" };

export default async function Page({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId: rawProjectId } = await params;
  const projectId = decodePrivateRouteSegment(rawProjectId);
  return <ProjectActivityTimelineV1 key={projectId} projectId={projectId} />;
}
