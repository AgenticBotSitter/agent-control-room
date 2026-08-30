import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { agents, blockers, projects, workers, workItems } from "@/src/fixtures/data";
import { ProtectedProjectDetailStatus } from "@/app/components/protected-detail-status";
import { AbsNewsWorkspace } from "@/app/components/abs-news-workspace";
import { ABS_NEWS_PROJECT_ID_V1, buildAbsNewsSyntheticWorkspaceV1 } from "@/src/project-adapters/abs-news/v1";
import { WayfarerWorkspace } from "@/app/components/wayfarer-workspace";
import { WAYFARER_PRESENTATION_PROJECT_ID_V1, buildWayfarerWorkspaceViewV1 } from "@/src/project-adapters/wayfarer/v1";
import { AgentTeamWorkspace } from "@/app/components/agent-team-workspace";
import { buildAgentTeamDurabilityFixtureV1, buildAgentTeamFixtureV1 } from "@/src/agent-team/v1";
import { ReadyFrontierProjectView } from "@/app/components/ready-frontier-view";
import { buildReadyFrontierAutomationProjectionFixtureV1, buildReadyFrontierCycleProjectionFixtureV1 } from "@/src/ready-frontier/v1";

export function generateStaticParams() {
  return projects.map((project) => ({ projectId: project.id }));
}

export async function generateMetadata({ params }: { params: Promise<{ projectId: string }> }): Promise<Metadata> {
  const { projectId } = await params;
  const project = projects.find((candidate) => candidate.id === projectId);
  return { title: project?.title ?? "Project" };
}

function label(value: string) {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export default async function ProjectDetail({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const project = projects.find((candidate) => candidate.id === projectId);
  if (!project) notFound();

  const projectWork = workItems.filter((item) => item.source.projectId === project.id);
  const projectBlockers = blockers.filter((item) => item.source.projectId === project.id);
  const projectWorkers = workers.filter((worker) =>
    worker.currentWorkItemIds?.some((id) => projectWork.some((item) => item.id === id)) ||
    worker.preferredProjectIds?.includes(project.id),
  );
  const projectAgents = agents.filter((agent) => agent.projectIds.includes(project.id));
  const isWayfarer = project.id === WAYFARER_PRESENTATION_PROJECT_ID_V1;

  return (
    <div className="detail-shell">
      <a className="skip-link" href="#project-detail">Skip to project details</a>
      <main id="project-detail" className="detail-main" tabIndex={-1}>
        <Link className="detail-back" href="/" prefetch={false}>← Back to all projects</Link>
        <header className="detail-hero">
          <div>
            <p className="eyebrow">{project.workspaceName} · Synthetic projection</p>
            <h1>{project.title}</h1>
            <p>{project.description}</p>
          </div>
          <span className={`health health-${project.health}`}>{label(project.health)}</span>
        </header>

        <p className="operator-data-status unavailable" role="status">This project detail is a synthetic fixture. Protected project status is available on the portfolio dashboard.</p>
        <ProtectedProjectDetailStatus projectId={project.id} />
        <ReadyFrontierProjectView data={{ state: "available", projection: buildReadyFrontierCycleProjectionFixtureV1() }}
          automation={buildReadyFrontierAutomationProjectionFixtureV1()} projectId={project.id} />
        <AgentTeamWorkspace fixture={buildAgentTeamFixtureV1(project.id)} durabilityFixture={buildAgentTeamDurabilityFixtureV1(project.id)} />
        {project.id === ABS_NEWS_PROJECT_ID_V1 ? <AbsNewsWorkspace fixture={buildAbsNewsSyntheticWorkspaceV1()} /> : null}
        {isWayfarer ? <WayfarerWorkspace fixture={buildWayfarerWorkspaceViewV1()} /> : null}
        {!isWayfarer ? <>
        <section className="metric-grid section-block" aria-label="Synthetic project summary">
          <article className="metric-card"><span className="metric-icon green">↗</span><div><small>Progress</small><strong>{project.progressPercent}%</strong><em>{label(project.domainState)}</em></div></article>
          <article className="metric-card"><span className="metric-icon amber">!</span><div><small>Blockers</small><strong>{project.blockerCount}</strong><em>{project.attentionCount} need attention</em></div></article>
          <article className="metric-card"><span className="metric-icon blue">◫</span><div><small>Workers</small><strong>{projectWorkers.length}</strong><em>visible to project</em></div></article>
          <article className="metric-card"><span className="metric-icon violet">◎</span><div><small>Authority</small><strong>{project.authorityMode === "control_room_native" ? "Native" : project.authorityMode === "source_scheduled" ? "Source" : "View"}</strong><em>{label(project.authorityMode)}</em></div></article>
        </section>

        <div className="detail-grid">
          <section className="detail-card">
            <h2>Fixture work and status</h2>
            <div className="detail-list">
              {projectWork.map((item) => (
                <article key={item.id}>
                  <h3>{item.title}</h3>
                  <p>{label(item.domainState)} · {item.requiredCapability ?? "Human decision"}</p>
                  <footer><span>{label(item.normalizedState)}</span><span>Priority {item.priority}</span><span>{item.progressPercent !== undefined ? `${item.progressPercent}%` : "—"}</span></footer>
                </article>
              ))}
            </div>
          </section>

          <div className="detail-list">
            <section className="detail-card">
              <h2>Project boundary</h2>
              <div className="capability-list">
                <article><h3>Authority mode</h3><p>{label(project.authorityMode)}</p><small>{project.authorityMode === "source_scheduled" ? "Control Room requests; source validates and leases." : project.authorityMode === "control_room_native" ? "Control Room may schedule installed project-pack jobs." : "Recommendations only."}</small></article>
                <article><h3>Source reference</h3><p>{project.source.sourceSystem} · v{project.source.sourceVersion}</p><small>Observed {new Date(project.source.observedAt).toLocaleString("en-US")}</small></article>
              </div>
            </section>
            <section className="detail-card">
              <h2>Workers and agents</h2>
              <div className="capability-list">
                {projectWorkers.map((worker) => <article key={worker.id}><h3><Link href={`/workers/${encodeURIComponent(worker.id)}`} prefetch={false}>{worker.displayName} →</Link></h3><p>{label(worker.state)} · {worker.availableSlots}/{worker.totalSlots} slots free</p><small>{worker.capabilities.length} routes</small></article>)}
                {projectAgents.map((agent) => <article key={agent.id}><h3>{agent.displayName}</h3><p>{label(agent.agentType)} · {label(agent.state)}</p><small>Separate reasoning identity</small></article>)}
              </div>
            </section>
          </div>
        </div>

        <section className="detail-card section-block">
          <h2>Fixture blockers</h2>
          <div className="blocker-grid">
            {projectBlockers.map((item) => <article key={item.id} className={`blocker-card severity-${item.severity}`}><div><span>{label(item.severity)}</span><small>{label(item.responsibleRole)}</small></div><h3>{item.title}</h3><p>{item.safeRemedy}</p></article>)}
            {!projectBlockers.length && <p className="empty-state">No blockers in this fixture snapshot.</p>}
          </div>
        </section>
        </> : null}
      </main>
    </div>
  );
}
