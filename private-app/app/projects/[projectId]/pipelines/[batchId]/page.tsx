import { PrivateProjectPipelines } from "../../../../project-pipelines-workspace";
import { decodePrivateRouteSegment } from "../../../../route-segment";

export const dynamic = "force-dynamic";
export const metadata = { title: "Pipeline batch · Control Room" };

export default async function Page({ params }: { params: Promise<{ projectId: string; batchId: string }> }) {
  const { projectId: rawProjectId, batchId: rawBatchId } = await params;
  return <PrivateProjectPipelines projectId={decodePrivateRouteSegment(rawProjectId)}
    batchId={decodePrivateRouteSegment(rawBatchId)} />;
}
