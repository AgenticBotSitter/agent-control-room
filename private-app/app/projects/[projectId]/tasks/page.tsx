import { PrivateTaskWorkspace } from "../../../task-workspace";
export const dynamic = "force-dynamic";
export const metadata = { title: "Project tasks · Control Room" };
export default async function Page({ params, searchParams }: {
  params: Promise<{ projectId: string }>; searchParams: Promise<{ after?: string }>;
}) {
  const { projectId } = await params, { after } = await searchParams;
  return <PrivateTaskWorkspace key={`${projectId}:${after ?? ""}`} projectId={projectId} after={after} />;
}
