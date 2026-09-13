import { PrivateTaskWorkspace } from "../../../task-workspace";
import { decodePrivateRouteSegment } from "../../../route-segment";
export const dynamic = "force-dynamic";
export const metadata = { title: "Project tasks · Control Room" };
export default async function Page({ params, searchParams }: {
  params: Promise<{ projectId: string }>; searchParams: Promise<{ after?: string }>;
}) {
  const { projectId: rawProjectId } = await params, { after } = await searchParams;
  const projectId = decodePrivateRouteSegment(rawProjectId);
  return <PrivateTaskWorkspace key={JSON.stringify([projectId, after ?? null])} projectId={projectId} after={after} />;
}
