import { PrivateTaskWorkspace } from "../../../../task-workspace";
export const dynamic = "force-dynamic";
export const metadata = { title: "Task progress · Control Room" };
export default async function Page({ params }: { params: Promise<{ projectId: string; jobId: string }> }) {
  const { projectId, jobId } = await params;
  return <PrivateTaskWorkspace key={JSON.stringify([projectId, jobId])} projectId={projectId} jobId={jobId} />;
}
