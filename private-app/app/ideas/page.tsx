import { PrivateIdeaWorkspace } from "../idea-workspace";
export const dynamic = "force-dynamic";
export const metadata = { title: "Idea Lab · Control Room" };
export default async function Page({ searchParams }: { searchParams: Promise<{ after?: string }> }) {
  const { after } = await searchParams;
  return <PrivateIdeaWorkspace key={after ?? "first"} after={after} />;
}
