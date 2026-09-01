import { ProjectWorkspaceShell } from "./project-workspace-shell";
import type { ReturnTypeIdeaLabUiFixtureV1 } from "@/app/fixtures/idea-lab-ui-types";
import { IdeaProjectLifecycleControls } from "./idea-project-lifecycle-controls";

function label(value: string): string {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}
export function IdeaPromotedProjectWorkspace({ fixture, sectionId = "overview",lifecycleControlsEnabled=false }: { fixture: ReturnTypeIdeaLabUiFixtureV1; sectionId?: string;lifecycleControlsEnabled?:boolean }) {
  const section = fixture.workspace.sections.find((candidate) => candidate.sectionId === sectionId);
  if (!section) throw new Error("idea project workspace section not found");
  const project = fixture.promotedProject;
  let content = <section className="detail-card"><h2>{section.label}</h2><p>This newly promoted project has no protected records in this section yet.</p><small>The page exists now; records appear only after a configured runtime writes them.</small></section>;
  if (sectionId === "overview") content = <div className="detail-grid">
    <section className="detail-card"><h2>Project lifecycle</h2><div className="capability-list">
      <article><h3>Current state</h3><p>{label(project.lifecycleState)}</p><small>Lifecycle version {project.version}</small></article>
      <article><h3>Origin</h3><p>Owner-promoted Idea Lab session</p><small>{project.sourceIdeaSessionId}</small></article>
      <article><h3>Monitoring page</h3><p>{project.monitoringPagePath}</p><small>Standard page for every registered project</small></article>
    </div></section>
    <section className="detail-card"><h2>First validation target</h2><p>{fixture.synthesis.nextExperiment}</p><small>No job has been dispatched from this fixture.</small></section>
  </div>;
  if (sectionId === "idea-origin") content = <section className="detail-card"><h2>Idea origin</h2><p>{fixture.session.ideaSummary}</p><div className="capability-list">{fixture.contributions.map((item) => <article key={item.contributionId}><h3>{label(item.perspective)}</h3><p>{item.safeOpinion}</p><small>{item.confidencePercent}% confidence · injected-only evidence</small></article>)}</div></section>;
  if (sectionId === "settings") content = <div className="detail-grid"><section className="detail-card"><h2>Identity</h2><p>{project.projectId}</p><small>{project.projectKind} · priority {project.priority}</small></section><section className="detail-card"><h2>Lifecycle controls</h2><p>Active → paused or completed → archived → reopened</p><IdeaProjectLifecycleControls project={project} enabled={lifecycleControlsEnabled}/></section></div>;
  return <ProjectWorkspaceShell snapshot={fixture.workspace} workspaceName={project.workspaceName} health="healthy" currentSectionId={sectionId}>{content}</ProjectWorkspaceShell>;
}
