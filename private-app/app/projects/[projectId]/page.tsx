import { PrivateProjectWorkspace } from "../../workspace";
export const dynamic = "force-dynamic";
export default async function ProjectPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return <PrivateProjectWorkspace key={projectId} projectId={projectId} />;
}
