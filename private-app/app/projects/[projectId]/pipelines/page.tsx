import { PrivateProjectPipelines } from "../../../project-pipelines-workspace";
import { decodePrivateRouteSegment } from "../../../route-segment";

export const dynamic = "force-dynamic";
export const metadata = { title: "Project pipelines · Control Room" };

export default async function Page({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId: rawProjectId } = await params;
  return <PrivateProjectPipelines projectId={decodePrivateRouteSegment(rawProjectId)} />;
}
