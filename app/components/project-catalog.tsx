export interface ProjectCatalogProps {
  state: "loading" | "ready" | "unavailable";
  projects: readonly { projectId: string; title: string; summary: string; lifecycle: "active" | "paused" | "completed" | "archived"; origin?: "ordinary" | "idea_lab" }[];
  selectedProjectId?: string;
  paginated?: boolean;
}
export function ProjectCatalog({ state, projects, selectedProjectId, paginated }: ProjectCatalogProps) {
  if (state === "loading") return <p role="status">Loading projects…</p>;
  if (state === "unavailable") return <p role="alert">Projects are unavailable. Try refreshing this view.</p>;
  if (!projects.length) return <p>{paginated ? "No projects on this page with your current access." : "No projects yet. Create your first project here."}</p>;
  const section = (archived: boolean) => {
    const entries = projects.filter(project => (project.lifecycle === "archived") === archived);
    if (!entries.length) return null;
    return <section aria-label={archived ? "Archived projects" : "Current projects"}>
      <h2>{archived ? "Archived" : "Your projects"}{paginated ? " on this page" : ""}</h2>
      <ul className="private-project-grid">{entries.map(project => <li key={project.projectId}>
        <a href={`/projects/${encodeURIComponent(project.projectId)}`} aria-current={selectedProjectId === project.projectId ? "page" : undefined}>
          <span className="private-state">{project.lifecycle}</span><h3>{project.title}</h3><p>{project.summary || "No summary added."}</p>
          {project.origin && <span className="private-note">{project.origin === "idea_lab" ? "From Idea Lab" : "Ordinary project"}</span>}
          <span className="private-open">Open project →</span>
        </a>
      </li>)}</ul>
    </section>;
  };
  return <>{section(false)}{section(true)}</>;
}
