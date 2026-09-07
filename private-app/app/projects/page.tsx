import { PrivateProjectWorkspace } from "../workspace";
export const dynamic = "force-dynamic";
export default async function ProjectsPage({ searchParams }: { searchParams: Promise<{ after?: string }> }) {
  const { after } = await searchParams;
  return <PrivateProjectWorkspace key={after ?? "first"} after={after} />;
}
