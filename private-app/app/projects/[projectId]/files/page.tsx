import { PrivateProjectFiles } from "../../../project-files-workspace";
import { decodePrivateRouteSegment } from "../../../route-segment";
export const dynamic = "force-dynamic";
export const metadata = { title: "Project files · Control Room" };
export default async function Page({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId: rawProjectId } = await params;
  const projectId = decodePrivateRouteSegment(rawProjectId);
  return <PrivateProjectFiles key={projectId} projectId={projectId} />;
}
