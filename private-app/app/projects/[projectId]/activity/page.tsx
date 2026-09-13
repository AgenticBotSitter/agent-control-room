import { PrivateProjectTaskView } from "../../../project-task-views";

export const dynamic = "force-dynamic";
export const metadata = { title: "Project activity · Control Room" };

export default async function Page({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return <PrivateProjectTaskView key={projectId} projectId={projectId} view="activity" />;
}
