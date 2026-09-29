import { ConfiguredTimestamp } from "../../private-app/app/configured-timestamp";
import { StateChip, LoadingState, EmptyState, UnavailableState, PanelHeading, PrivateCount } from "../../private-app/app/owner-ui";

export interface ProjectCatalogProps {
  state: "loading" | "ready" | "unavailable";
  projects: readonly { projectId: string; title: string; summary: string; lifecycle: "active" | "paused" | "completed" | "archived";
    updatedAt: string; origin?: "ordinary" | "idea_lab" }[];
  selectedProjectId?: string;
  paginated?: boolean;
  projectHref?: (projectId: string) => string;
}
export function ProjectCatalog({ state, projects, selectedProjectId, paginated,
  projectHref = id => `/projects/${encodeURIComponent(id)}` }: ProjectCatalogProps) {
  if (state === "loading") return <LoadingState>Loading projects…</LoadingState>;
  if (state === "unavailable") return <UnavailableState urgent>Projects are unavailable. Try refreshing this view.</UnavailableState>;
  if (!projects.length) return <EmptyState>{paginated ? "No projects on this page with your current access." : "No projects yet. Create your first project here."}</EmptyState>;
  const section = (archived: boolean) => {
    const entries = projects.filter(project => (project.lifecycle === "archived") === archived);
    if (!entries.length) return null;
    return <section aria-label={archived ? "Archived projects" : "Current projects"}>
      <PanelHeading id={archived ? "projects-archived" : "projects-current"}>
        {archived ? "Archived" : "Your projects"}{paginated ? " on this page" : ""}
        <PrivateCount value={entries.length} />
      </PanelHeading>
      <ul className="private-project-grid">{entries.map(project => <li key={project.projectId}>
        <a href={projectHref(project.projectId)} aria-current={selectedProjectId === project.projectId ? "page" : undefined}>
          <StateChip state={project.lifecycle} /><h3>{project.title}</h3><p>{project.summary || "No summary added."}</p>
          {project.origin && <span className="private-note">{project.origin === "idea_lab" ? "From Idea Lab" : "Ordinary project"}</span>}
          <span className="private-note"><ConfiguredTimestamp value={project.updatedAt} prefix="Updated" /></span>
          <span className="private-open">Open project →</span>
        </a>
        <a className="private-project-new-tab" href={projectHref(project.projectId)}
          target="_blank" rel="noopener noreferrer" aria-label={`Open ${project.title} in a new tab`}>Open in new tab ↗</a>
      </li>)}</ul>
    </section>;
  };
  return <>{section(false)}{section(true)}</>;
}
