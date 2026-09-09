import { PrivateIdeaWorkspace } from "../../idea-workspace";
export const dynamic = "force-dynamic";
export const metadata = { title: "Idea discussion · Control Room" };
export default async function Page({ params }: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await params;
  return <PrivateIdeaWorkspace key={sessionId} sessionId={sessionId} />;
}
