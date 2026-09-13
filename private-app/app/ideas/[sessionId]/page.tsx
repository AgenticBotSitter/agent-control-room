import { PrivateIdeaWorkspace } from "../../idea-workspace";
import { decodePrivateRouteSegment } from "../../route-segment";
export const dynamic = "force-dynamic";
export const metadata = { title: "Idea discussion · Control Room" };
export default async function Page({ params }: { params: Promise<{ sessionId: string }> }) {
  const { sessionId: rawSessionId } = await params;
  const sessionId = decodePrivateRouteSegment(rawSessionId);
  return <PrivateIdeaWorkspace key={sessionId} sessionId={sessionId} />;
}
