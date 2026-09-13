import { PrivateTaskWorkspace } from "../../../../task-workspace";
import { decodePrivateRouteSegment } from "../../../../route-segment";
export const dynamic = "force-dynamic";
export const metadata = { title: "Task progress · Control Room" };
export default async function Page({ params }: { params: Promise<{ projectId: string; jobId: string }> }) {
  const { projectId: rawProjectId, jobId: rawJobId } = await params;
  const projectId = decodePrivateRouteSegment(rawProjectId), jobId = decodePrivateRouteSegment(rawJobId);
  return <PrivateTaskWorkspace key={JSON.stringify([projectId, jobId])} projectId={projectId} jobId={jobId} />;
}
