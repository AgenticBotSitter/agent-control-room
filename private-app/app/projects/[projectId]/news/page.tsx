import { PrivateNewsWorkspace } from "../../../news-workspace";
export const dynamic = "force-dynamic";
export const metadata = { title: "Project news · Control Room" };
export default async function Page({ params, searchParams }: {
  params: Promise<{ projectId: string }>; searchParams: Promise<{ after?: string; sourceAfter?: string; view?: string; order?: string }>;
}) {
  const { projectId } = await params, { after, sourceAfter, view, order } = await searchParams;
  const selectedView = view === "archive" || view === "fresh" ? view : "history";
  const selectedOrder = order === "newest" || order === "oldest" ? order : "important";
  return <PrivateNewsWorkspace key={`${projectId}:${after ?? ""}:${sourceAfter ?? ""}:${selectedView}:${selectedOrder}`} projectId={projectId} after={after} sourceAfter={sourceAfter} view={selectedView} order={selectedOrder} />;
}
