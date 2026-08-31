import { AgentTeamWorkspace } from "@/app/components/agent-team-workspace";
import { AbsNewsWorkspace } from "@/app/components/abs-news-workspace";
import { ProjectWorkspaceShell } from "@/app/components/project-workspace-shell";
import { ProtectedProjectDetailStatus } from "@/app/components/protected-detail-status";
import { ReadyFrontierProjectView } from "@/app/components/ready-frontier-view";
import { WayfarerWorkspace } from "@/app/components/wayfarer-workspace";
import { buildProjectWorkspaceUiFixtureV1 } from "@/app/fixtures/project-workspace-ui";
import { buildAgentTeamDurabilityFixtureV1, buildAgentTeamFixtureV1 } from "@/src/agent-team/v1";
import { agents, attentionItems, blockers, projects, recentActivity, workers, workItems } from "@/src/fixtures/data";
import { ABS_NEWS_PROJECT_ID_V1, buildAbsNewsSyntheticWorkspaceV1 } from "@/src/project-adapters/abs-news/v1";
import { WAYFARER_PRESENTATION_PROJECT_ID_V1, buildWayfarerWorkspaceViewV1 } from "@/src/project-adapters/wayfarer/v1";
import { buildReadyFrontierAutomationProjectionFixtureV1, buildReadyFrontierCycleProjectionFixtureV1,
  buildReadyFrontierNoRelayProjectionFixtureV1, buildReadyFrontierPromotionProjectionFixtureV1 } from "@/src/ready-frontier/v1";

function label(value: string): string {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function EmptySection({ title, detail }: { title: string; detail: string }) {
  return <div className="detail-card project-workspace-empty"><h3>{title}</h3><p>{detail}</p>
    <small>No protected record, approval, command, or effect is inferred.</small></div>;
}

export function ProjectWorkspacePage({ projectId, sectionId = "overview" }: { projectId: string; sectionId?: string }) {
  const project = projects.find((candidate) => candidate.id === projectId);
  const snapshot = buildProjectWorkspaceUiFixtureV1(projectId);
  if (!project || !snapshot) throw new Error("project workspace not found");
  const section = snapshot.sections.find((candidate) => candidate.sectionId === sectionId);
  if (!section) throw new Error("project workspace section not found");

  const projectWork = workItems.filter((item) => item.source.projectId === projectId);
  const projectBlockers = blockers.filter((item) => item.source.projectId === projectId);
  const projectAttention = attentionItems.filter((item) => item.source.projectId === projectId);
  const projectAgents = agents.filter((agent) => agent.projectIds.includes(projectId));
  const projectWorkers = workers.filter((worker) => worker.currentWorkItemIds?.some((id) => projectWork.some((item) => item.id === id))
    || worker.preferredProjectIds?.includes(projectId));
  const activity = recentActivity.filter((item) => item.projectId === projectId);

  let content;
  if (sectionId === "overview") {
    content = <>
      <ProtectedProjectDetailStatus projectId={projectId} />
      <section className="metric-grid" aria-label="Project summary">
        <article className="metric-card"><span className="metric-icon green">↗</span><div><small>Progress</small><strong>{project.progressPercent ?? 0}%</strong><em>{label(project.domainState)}</em></div></article>
        <article className="metric-card"><span className="metric-icon amber">!</span><div><small>Needs attention</small><strong>{projectAttention.length}</strong><em>{projectBlockers.length} blockers observed</em></div></article>
        <article className="metric-card"><span className="metric-icon blue">◫</span><div><small>Workers</small><strong>{projectWorkers.length}</strong><em>{projectAgents.length} agents in scope</em></div></article>
        <article className="metric-card"><span className="metric-icon violet">◎</span><div><small>Authority</small><strong>{project.authorityMode === "control_room_native" ? "Native" : project.authorityMode === "source_scheduled" ? "Source" : "View"}</strong><em>{label(project.authorityMode)}</em></div></article>
      </section>
      <div className="detail-grid">
        <section className="detail-card"><h2>Current work</h2><div className="detail-list">
          {projectWork.slice(0, 4).map((item) => <article key={item.id}><h3>{item.title}</h3><p>{label(item.domainState)}</p><footer><span>{label(item.normalizedState)}</span><span>Priority {item.priority}</span><span>{item.progressPercent !== undefined ? `${item.progressPercent}%` : "—"}</span></footer></article>)}
          {!projectWork.length ? <p className="empty-state">No synthetic work records are present.</p> : null}
        </div></section>
        <section className="detail-card"><h2>Project boundary</h2><div className="capability-list">
          <article><h3>Authority mode</h3><p>{label(project.authorityMode)}</p><small>{project.authorityMode === "source_scheduled" ? "The source validates scheduling and leases." : project.authorityMode === "control_room_native" ? "Only separately authorized installed jobs may run." : "Recommendations and observation only."}</small></article>
          <article><h3>Source reference</h3><p>{project.source.sourceSystem} · v{project.source.sourceVersion}</p><small>Observed {new Date(project.source.observedAt).toLocaleString("en-US")}</small></article>
        </div></section>
      </div>
    </>;
  } else if (sectionId === "inbox") {
    content = <div className="detail-grid"><section className="detail-card"><h2>Attention items</h2><div className="detail-list">
      {projectAttention.map((item) => <article key={item.id}><h3>{item.title}</h3><p>{item.summary}</p><footer><span>{label(item.type)}</span><span>{item.dueAt ? `Due ${new Date(item.dueAt).toLocaleString("en-US")}` : "No due time"}</span></footer></article>)}
      {!projectAttention.length ? <p className="empty-state">Nothing in this synthetic project currently needs owner attention.</p> : null}
    </div></section><section className="detail-card"><h2>Blockers</h2><div className="detail-list">
      {projectBlockers.map((item) => <article key={item.id}><h3>{item.title}</h3><p>{item.safeRemedy ?? "No safe remedy is projected."}</p><footer><span>{label(item.severity)}</span><span>{label(item.responsibleRole)}</span></footer></article>)}
      {!projectBlockers.length ? <p className="empty-state">No blockers in this fixture snapshot.</p> : null}
    </div></section></div>;
  } else if (sectionId === "work") {
    content = <section className="detail-card"><h2>Project work</h2><div className="project-workspace-work-grid">
      {projectWork.map((item) => <article key={item.id}><div><span>{label(item.normalizedState)}</span><b>Priority {item.priority}</b></div><h3>{item.title}</h3><p>{label(item.domainState)} · {item.requiredCapability ?? "Human decision"}</p><footer><small>{item.currentWorkerId ?? "Unassigned"}</small><strong>{item.progressPercent !== undefined ? `${item.progressPercent}%` : "—"}</strong></footer></article>)}
      {!projectWork.length ? <p className="empty-state">No work records are present in this fixture.</p> : null}
    </div></section>;
  } else if (sectionId === "agents") {
    content = <><div className="detail-grid"><section className="detail-card"><h2>Agents</h2><div className="capability-list">
      {projectAgents.map((agent) => <article key={agent.id}><h3>{agent.displayName}</h3><p>{label(agent.agentType)} · {label(agent.state)}</p><small>{agent.allowedActions.length} bounded actions projected</small></article>)}
    </div></section><section className="detail-card"><h2>Workers</h2><div className="capability-list">
      {projectWorkers.map((worker) => <article key={worker.id}><h3><a href={`/workers/${encodeURIComponent(worker.id)}`}>{worker.displayName} →</a></h3><p>{label(worker.state)} · {worker.availableSlots}/{worker.totalSlots} slots free</p><small>{worker.capabilities.length} observed routes</small></article>)}
    </div></section></div><AgentTeamWorkspace fixture={buildAgentTeamFixtureV1(projectId)} durabilityFixture={buildAgentTeamDurabilityFixtureV1(projectId)} /></>;
  } else if (sectionId === "automations") {
    content = <ReadyFrontierProjectView data={{ state: "available", projection: buildReadyFrontierCycleProjectionFixtureV1() }}
      automation={buildReadyFrontierAutomationProjectionFixtureV1()} promotion={buildReadyFrontierPromotionProjectionFixtureV1()}
      noRelay={buildReadyFrontierNoRelayProjectionFixtureV1()} projectId={projectId} />;
  } else if (sectionId === "artifacts") {
    content = <EmptySection title="No authenticated artifact index is connected" detail="Artifact contracts and project-specific evidence exist elsewhere, but this shared workspace will not invent a file listing from unrelated fixtures." />;
  } else if (sectionId === "reviews") {
    const reviews = projectAttention.filter((item) => item.type === "review");
    content = <section className="detail-card"><h2>Review queue</h2><div className="detail-list">
      {reviews.map((item) => <article key={item.id}><h3>{item.title}</h3><p>{item.summary}</p><footer><span>Review requested</span><span>{item.dueAt ? new Date(item.dueAt).toLocaleString("en-US") : "No due time"}</span></footer></article>)}
      {!reviews.length ? <p className="empty-state">No review records are present in this synthetic project view.</p> : null}
    </div></section>;
  } else if (sectionId === "activity") {
    content = <section className="detail-card"><h2>Recent project activity</h2><ul className="activity-list">
      {activity.map((item) => <li key={item.id}><i className={item.tone === "good" ? "event-good" : item.tone === "warn" ? "event-warn" : ""} /><time>{item.time}</time><div><b>{item.actor}</b><p>{item.action}</p><small>Synthetic event projection</small></div></li>)}
      {!activity.length ? <li><i /><time>—</time><div><b>No activity</b><p>No synthetic events are present.</p></div></li> : null}
    </ul></section>;
  } else if (sectionId === "settings") {
    content = <div className="detail-grid"><section className="detail-card"><h2>Project identity</h2><div className="capability-list">
      <article><h3>Project</h3><p>{project.id}</p><small>{project.workspaceName}</small></article>
      <article><h3>Adapter</h3><p>{project.source.adapterId}</p><small>{project.source.sourceSystem} · v{project.source.sourceVersion}</small></article>
    </div></section><section className="detail-card"><h2>Authority settings</h2><div className="capability-list">
      <article><h3>Mode</h3><p>{label(project.authorityMode)}</p><small>This view cannot change the mode.</small></article>
      <article><h3>Workspace controls</h3><p>Presentation only</p><small>Approval, network, command, lease, and execution remain false.</small></article>
    </div></section></div>;
  } else if (projectId === ABS_NEWS_PROJECT_ID_V1) {
    content = <AbsNewsWorkspace fixture={buildAbsNewsSyntheticWorkspaceV1()} showNavigation={false} />;
  } else if (projectId === WAYFARER_PRESENTATION_PROJECT_ID_V1) {
    content = <WayfarerWorkspace fixture={buildWayfarerWorkspaceViewV1()} />;
  } else {
    content = <EmptySection title={`${section.label} has no configured projection`} detail="The project registered this extension, but no safe local presentation is available." />;
  }

  return <ProjectWorkspaceShell snapshot={snapshot} workspaceName={project.workspaceName} health={project.health}
    currentSectionId={sectionId}>{content}</ProjectWorkspaceShell>;
}
