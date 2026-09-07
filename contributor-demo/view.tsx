import { LocalPilotOwnerSession } from "../app/components/local-pilot-owner-session";
import { LocalProjectWorkspace } from "../app/local-preview/workspace";
import { catalogProjectIdSchema } from "../src/web/v1/project-wire";

export function contributorDemoSelection(search: string) {
  const params = new URLSearchParams(search), keys = [...params.keys()];
  if (keys.length > 3 || new Set(keys).size !== keys.length || keys.some(key => !["project", "job", "after"].includes(key))
    || [...params.values()].some(value => !catalogProjectIdSchema.safeParse(value).success)
    || params.has("job") && (!params.has("project") || params.has("after"))) throw new Error("invalid_demo_link");
  return { projectId: params.get("project") ?? undefined, jobId: params.get("job") ?? undefined,
    after: params.get("after") ?? undefined };
}

export function ContributorDemoView({ search }: { search: string }) {
  let selected;
  try { selected = contributorDemoSelection(search); }
  catch { return <main><h1>Invalid demo link</h1><a href="/local-preview">Open projects</a></main>; }
  return <><div className="private-shell"><header className="private-header">
    <strong className="private-brand">Agent Control Room</strong>
    <span>Disposable contributor demo · no real agents</span>
  </header><LocalPilotOwnerSession /></div>
  <LocalProjectWorkspace key={`${selected.projectId ?? ""}/${selected.jobId ?? ""}/${selected.after ?? ""}`}
    {...selected} contributorDemo /></>;
}
