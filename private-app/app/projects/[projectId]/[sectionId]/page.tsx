import { PrivateProjectWorkspace } from "../../../workspace";
export const dynamic = "force-dynamic";
export default async function ProjectSection({ params }: { params: Promise<{ projectId: string; sectionId: string }> }) {
  const { projectId, sectionId } = await params;
  return <PrivateProjectWorkspace key={projectId} projectId={projectId} section={sectionId} />;
}
