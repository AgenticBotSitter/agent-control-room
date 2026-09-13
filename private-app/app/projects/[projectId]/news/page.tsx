import { PrivateNewsWorkspace } from "../../../news-workspace";
import { decodePrivateRouteSegment } from "../../../route-segment";
export const dynamic = "force-dynamic";
export const metadata = { title: "Project news · Control Room" };
export default async function Page({ params, searchParams }: {
  params: Promise<{ projectId: string }>; searchParams: Promise<{ after?: string; sourceAfter?: string; view?: string; order?: string }>;
}) {
  const { projectId: rawProjectId } = await params, { after, sourceAfter, view, order } = await searchParams;
  const projectId = decodePrivateRouteSegment(rawProjectId);
  const selectedView = view === "archive" || view === "fresh" ? view : "history";
  const selectedOrder = order === "newest" || order === "oldest" ? order : "important";
  return <PrivateNewsWorkspace key={JSON.stringify([projectId, after ?? null, sourceAfter ?? null, selectedView, selectedOrder])} projectId={projectId} after={after} sourceAfter={sourceAfter} view={selectedView} order={selectedOrder} />;
}
