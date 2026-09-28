import { lifecycleSchema, type WebProject } from "../../../src/web/v1/project-wire";
import { PrivateProjectWorkspace } from "../workspace";
export const dynamic = "force-dynamic";
export default async function ProjectsPage({ searchParams }: { searchParams: Promise<{ after?: string; lifecycle?: string }> }) {
  const { after, lifecycle: input } = await searchParams;
  const parsed = lifecycleSchema.safeParse(input);
  const lifecycle = parsed.success ? parsed.data as WebProject["lifecycle"] : undefined;
  return <PrivateProjectWorkspace key={`${lifecycle ?? "all"}:${after ?? "first"}`} after={after} lifecycleFilter={lifecycle}
    invalidLifecycleFilter={input !== undefined && !parsed.success} />;
}
