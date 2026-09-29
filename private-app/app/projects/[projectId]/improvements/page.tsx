import { PrivateImproveControlRoomWorkspace } from "../../../improve-control-room-workspace";
import { decodePrivateRouteSegment } from "../../../route-segment";

export const dynamic = "force-dynamic";
export const metadata = { title: "Improve Control Room" };

export default async function Page({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return <PrivateImproveControlRoomWorkspace projectId={decodePrivateRouteSegment(projectId)} />;
}

