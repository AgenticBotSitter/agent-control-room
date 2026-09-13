import { PrivateProjectFiles } from "../../../project-files-workspace";
export const dynamic = "force-dynamic";
export const metadata = { title: "Project files · Control Room" };
export default async function Page({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return <PrivateProjectFiles key={projectId} projectId={projectId} />;
}
