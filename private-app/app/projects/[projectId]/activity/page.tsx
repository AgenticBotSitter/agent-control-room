import { PrivateProjectTaskView } from "../../../project-task-views";
import { decodePrivateRouteSegment } from "../../../route-segment";

export const dynamic = "force-dynamic";
export const metadata = { title: "Project activity · Control Room" };

export default async function Page({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId: rawProjectId } = await params;
  const projectId = decodePrivateRouteSegment(rawProjectId);
  return <PrivateProjectTaskView key={projectId} projectId={projectId} view="activity" />;
}
