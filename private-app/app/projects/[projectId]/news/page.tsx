import { PrivateNewsWorkspace } from "../../../news-workspace";
export const dynamic = "force-dynamic";
export const metadata = { title: "Project news · Control Room" };
export default async function Page({ params, searchParams }: {
  params: Promise<{ projectId: string }>; searchParams: Promise<{ after?: string; sourceAfter?: string }>;
}) {
  const { projectId } = await params, { after, sourceAfter } = await searchParams;
  return <PrivateNewsWorkspace key={`${projectId}:${after ?? ""}:${sourceAfter ?? ""}`} projectId={projectId} after={after} sourceAfter={sourceAfter} />;
}
