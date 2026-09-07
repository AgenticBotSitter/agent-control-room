import { PrivateNewsWorkspace } from "../../../news-workspace";
export const dynamic = "force-dynamic";
export const metadata = { title: "Project news · Control Room" };
export default async function Page({ params, searchParams }: {
  params: Promise<{ projectId: string }>; searchParams: Promise<{ after?: string }>;
}) {
  const { projectId } = await params, { after } = await searchParams;
  return <PrivateNewsWorkspace key={`${projectId}:${after ?? ""}`} projectId={projectId} after={after} />;
}
