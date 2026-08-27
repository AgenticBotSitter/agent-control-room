"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  agents,
  blockers,
  projects,
  recentActivity,
  workers,
  workItems,
} from "@/src/fixtures/data";
import { portfolioScheduleScenario, transcriptionScenarios } from "@/src/simulator/scenarios";
import { cr6eActionInboxFixture, cr6eOwnerFocusFixture } from "./fixtures/cr6e-ui";
import { ActionInbox } from "./components/action-inbox";
import { OwnerFocusStrip, type OwnerFocusDraftRequestV1 } from "./components/owner-focus-strip";
import { FleetProjection } from "./components/fleet-projection";
import { ServiceIncidentList } from "./components/service-incident-list";
import { BottleneckList } from "./components/bottleneck-list";
import { ActiveWorkList } from "./components/active-work-list";
import { ServiceScheduleList } from "./components/service-schedule-list";
import { PortfolioProjection } from "./components/portfolio-projection";
import { fetchOperatorSurfaceSnapshotV1, saveOwnerFocusV1, type OperatorSurfaceDataStateV1 } from "@/src/operator-surfaces/v1";

type Scope = "all" | string;
type ScenarioKey = keyof typeof transcriptionScenarios;

const projectAccent: Record<string, string> = {
  "project.wayfarer.lazy-river": "river",
  "project.blooms.content-ops": "bloom",
  "project.website.public-site": "site",
};

function stateLabel(value: string): string {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function relativeHeartbeat(value: string): string {
  const seconds = Math.max(0, Math.round((Date.parse("2026-08-22T17:30:00.000Z") - Date.parse(value)) / 1000));
  return `${seconds}s ago`;
}

function projectName(projectId: string): string {
  return projects.find((project) => project.id === projectId)?.workspaceName ?? "Control Room";
}

export function ControlRoomDashboard() {
  const [scope, setScope] = useState<Scope>("all");
  const [theme, setTheme] = useState<"light" | "dark">("dark");
  const [scenarioKey, setScenarioKey] = useState<ScenarioKey>("automatic");
  const [simulationApplied, setSimulationApplied] = useState(false);
  const [ownerFocusNotice, setOwnerFocusNotice] = useState<string>();
  const [operatorData, setOperatorData] = useState<OperatorSurfaceDataStateV1>({ state: "loading" });

  useEffect(() => {
    const saved = window.localStorage.getItem("control-room-theme");
    const initial = saved === "light" || saved === "dark"
      ? saved
      : window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light";
    document.documentElement.dataset.theme = initial;
    const frame = window.requestAnimationFrame(() => setTheme(initial));
    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    let current = true;
    void fetchOperatorSurfaceSnapshotV1().then((result) => {
      if (current) setOperatorData(result);
    });
    return () => { current = false; };
  }, []);

  const toggleTheme = () => {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.dataset.theme = next;
    window.localStorage.setItem("control-room-theme", next);
  };

  const submitOwnerFocus = async (request: OwnerFocusDraftRequestV1) => {
    const project = projects.find((candidate) => candidate.id === request.projectId)?.workspaceName ?? request.projectId;
    setOwnerFocusNotice("Saving protected Owner Focus intent…");
    const result = await saveOwnerFocusV1(request);
    if (result.state !== "unavailable") {
      setOwnerFocusNotice(request.operation === "clear_owner_focus"
        ? `Owner Focus cleared for ${project}. No schedule or dispatch changed.`
        : `${request.level === "p0" ? "P0" : "Today"} Owner Focus saved for ${project}. No schedule or dispatch changed.`);
      const refreshed = await fetchOperatorSurfaceSnapshotV1();
      setOperatorData(refreshed);
      return;
    }
    setOwnerFocusNotice(result.code === "owner_focus_forbidden"
      ? "Your current Control Room role cannot save Owner Focus for this project."
      : result.code === "authentication_required"
        ? "Sign in is required before Owner Focus can be saved."
        : "Owner Focus could not be saved. No change was made.");
  };

  const operatorSnapshot = operatorData.state === "available" ? operatorData.snapshot : undefined;
  const activeScope = operatorSnapshot && scope !== "all" && !operatorSnapshot.portfolio.some((project) => project.projectId === scope) ? "all" : scope;
  const scopeOptions = operatorSnapshot
    ? operatorSnapshot.portfolio.map((project) => ({ id: project.projectId, label: project.projectId }))
    : projects.map((project) => ({ id: project.id, label: `${project.workspaceName} · ${project.title}` }));
  const scopedProjects = useMemo(() => activeScope === "all" ? projects : projects.filter((project) => project.id === activeScope), [activeScope]);
  const scopedIds = new Set(operatorSnapshot ? (activeScope === "all" ? operatorSnapshot.portfolio.map((project) => project.projectId) : [activeScope]) : scopedProjects.map((project) => project.id));
  const scopedPortfolio = operatorSnapshot?.portfolio.filter((project) => scopedIds.has(project.projectId));
  const actionInbox = operatorSnapshot?.actionInbox ?? cr6eActionInboxFixture;
  const ownerFocus = operatorSnapshot?.ownerFocus ?? cr6eOwnerFocusFixture;
  const scopedActionInbox = actionInbox.filter((item) => !item.projectId || scopedIds.has(item.projectId));
  const scopedOwnerFocus = ownerFocus.filter((pin) => scopedIds.has(pin.projectId));
  const focusProjects = operatorSnapshot ? operatorSnapshot.portfolio.filter((project) => scopedIds.has(project.projectId)).map((project) => ({ id: project.projectId, label: project.projectId })) : scopedProjects.map((project) => ({ id: project.id, label: project.workspaceName }));
  const scopedBlockers = blockers.filter((item) => scopedIds.has(item.source.projectId));
  const scopedWork = workItems.filter((item) => scopedIds.has(item.source.projectId));
  const scopedActivity = recentActivity.filter((item) => scopedIds.has(item.projectId));
  const running = scopedWork.filter((item) => item.normalizedState === "running");
  const protectedActiveWork = operatorSnapshot?.activeWork.filter((item) => scopedIds.has(item.projectId));
  const scenario = transcriptionScenarios[scenarioKey];

  const totalProgress = Math.round(
    scopedProjects.reduce((sum, project) => sum + (project.progressPercent ?? 0), 0) / Math.max(scopedProjects.length, 1),
  );
  const syntheticActiveWorkers = workers.filter((worker) => worker.state !== "offline" && worker.state !== "maintenance").length;
  const protectedActiveWorkers = operatorSnapshot?.fleet.filter((worker) => worker.state !== "offline" && worker.state !== "maintenance").length;
  const activeWorkers = protectedActiveWorkers ?? syntheticActiveWorkers;
  const displayedWorkerCount = operatorSnapshot?.fleet.length ?? workers.length;
  const availableSlots = operatorSnapshot?.fleet.reduce((sum, worker) => sum + (worker.capacityState === "reported" ? worker.availableSlots ?? 0 : 0), 0) ?? workers.reduce((sum, worker) => sum + worker.availableSlots, 0);
  const operatorDataMessage = operatorData.state === "available"
    ? "Protected operator data"
    : operatorData.state === "loading"
      ? "Protected data loading; synthetic fixture is shown until it arrives"
      : operatorData.code === "authentication_required"
        ? "Sign in is required; synthetic fixture is shown"
        : "Protected operator data is unavailable; synthetic fixture is shown";

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">Skip to operations</a>

      <aside className="sidebar" aria-label="Primary navigation">
        <Link className="brand" href="/" prefetch={false} aria-label="Control Room home">
          <span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>
          <span><strong>Control Room</strong><small>Private operations</small></span>
        </Link>

        <nav className="side-nav">
          <a className="active" href="#overview"><span aria-hidden="true">⌂</span> Overview</a>
          <a href="#projects"><span aria-hidden="true">▦</span> Projects</a>
          <a href="#attention"><span aria-hidden="true">◆</span> Needs Me <b>{scopedActionInbox.length}</b></a>
          <a href="#workers"><span aria-hidden="true">◫</span> Workers</a>
          {operatorSnapshot && <a href="#services"><span aria-hidden="true">◌</span> Services</a>}
          <a href="#agents"><span aria-hidden="true">◎</span> Agents</a>
          <a href="#capacity"><span aria-hidden="true">⌁</span> Capacity</a>
          <a href="#activity"><span aria-hidden="true">≡</span> Activity</a>
        </nav>

        <div className="sidebar-foot">
          <span className={`connection-dot ${operatorData.state === "available" ? "protected" : "synthetic"}`} /> {operatorData.state === "available" ? "Protected data connected" : "Synthetic adapters active"}
          <small>{operatorData.state === "available" ? "Tenant-bound read projection" : "No protected data is being claimed"}</small>
        </div>
      </aside>

      <main id="main-content" className="main-content">
        <header className="topbar">
          <div className="scope-control">
            <label htmlFor="project-scope">Viewing</label>
            <select id="project-scope" value={activeScope} onChange={(event) => setScope(event.target.value as Scope)}>
              <option value="all">All projects</option>
              {scopeOptions.map((project) => (
                <option key={project.id} value={project.id}>{project.label}</option>
              ))}
            </select>
          </div>
          <div className="top-actions">
            <span className="freshness"><i /> {operatorSnapshot ? `Projection ${new Date(operatorSnapshot.generatedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : "Fixture snapshot"}</span>
            <button className="icon-button" type="button" onClick={toggleTheme} aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}>
              {theme === "dark" ? "☼" : "◐"}
            </button>
            <button className="avatar-button" type="button" aria-label="Owner account">AF</button>
          </div>
        </header>

        <section id="overview" className="hero-section">
          <div>
            <p className="eyebrow">Portfolio command view</p>
            <h1>{activeScope === "all" ? "Everything moving, in one room." : operatorSnapshot ? activeScope : scopedProjects[0]?.title}</h1>
            <p className="hero-copy">
              {activeScope === "all"
                ? "Portfolio status across every project, worker, agent, blocker, and allocation decision."
                : operatorSnapshot ? `Protected status for ${activeScope}.` : `${scopedProjects[0]?.workspaceName} · ${stateLabel(scopedProjects[0]?.domainState ?? "")}`}
            </p>
            <p className={`operator-data-status ${operatorData.state}`} aria-live="polite">{operatorDataMessage}</p>
          </div>
          <span className="prototype-badge">{operatorData.state === "available" ? "Protected projection" : "Synthetic fixture"}</span>
        </section>

        <OwnerFocusStrip pins={scopedOwnerFocus} projects={focusProjects} onSubmit={submitOwnerFocus} notice={ownerFocusNotice} />

        <section className="metric-grid" aria-label="Portfolio summary">
          <article className="metric-card">
            <span className="metric-icon green">↗</span>
            <div><small>{operatorSnapshot ? "Protected workflows" : "Average progress"}</small><strong>{operatorSnapshot ? scopedPortfolio?.reduce((sum, project) => sum + project.workflowCount, 0) ?? 0 : `${totalProgress}%`}</strong><em>{operatorSnapshot ? `${scopedPortfolio?.length ?? 0} project${scopedPortfolio?.length === 1 ? "" : "s"} in scope` : `${scopedProjects.length} project${scopedProjects.length === 1 ? "" : "s"} in scope`}</em></div>
          </article>
          <article className="metric-card">
            <span className="metric-icon amber">!</span>
            <div><small>Needs your attention</small><strong>{scopedActionInbox.length}</strong><em>{operatorSnapshot ? "protected decision records" : `${scopedBlockers.filter((item) => item.severity === "critical").length} critical blocker`}</em></div>
          </article>
          <article className="metric-card">
            <span className="metric-icon blue">◫</span>
            <div><small>Workers observed</small><strong>{activeWorkers}/{displayedWorkerCount}</strong><em>{operatorSnapshot?.fleet.some((worker) => worker.capacityState === "unavailable") ? "some capacity unavailable" : `${availableSlots} slots currently free`}</em></div>
          </article>
          <article className="metric-card">
            <span className="metric-icon violet">◎</span>
            <div><small>Running now</small><strong>{operatorSnapshot ? protectedActiveWork?.length ?? 0 : running.length}</strong><em>{operatorSnapshot ? `across ${new Set(protectedActiveWork?.map((item) => item.projectId)).size} projects` : `across ${new Set(running.map((item) => item.source.projectId)).size} projects`}</em></div>
          </article>
        </section>

        <section id="projects" className="section-block">
          <div className="section-heading">
            <div><p className="eyebrow">Portfolio</p><h2>Active projects</h2></div>
            {activeScope !== "all" && <button className="text-button" type="button" onClick={() => setScope("all")}>Show all projects</button>}
          </div>
          {operatorSnapshot ? <PortfolioProjection projects={scopedPortfolio ?? []} /> : <div className="project-grid">
            {scopedProjects.map((project) => (
              <article key={project.id} className={`project-card accent-${projectAccent[project.id]}`}>
                <div className="project-topline">
                  <span className="project-monogram">{project.workspaceName.split(" ").map((word) => word[0]).join("").slice(0, 2)}</span>
                  <span className={`health health-${project.health}`}>{stateLabel(project.health)}</span>
                </div>
                <p>{project.workspaceName}</p>
                <h3>{project.title}</h3>
                <div className="progress-row"><span><i style={{ width: `${project.progressPercent ?? 0}%` }} /></span><b>{project.progressPercent}%</b></div>
                <dl className="project-stats">
                  <div><dt>Authority</dt><dd>{stateLabel(project.authorityMode)}</dd></div>
                  <div><dt>Attention</dt><dd>{project.attentionCount}</dd></div>
                  <div><dt>Blockers</dt><dd>{project.blockerCount}</dd></div>
                </dl>
                <div className="card-actions">
                  <button type="button" onClick={() => setScope(project.id as Scope)}>Focus here</button>
                  <Link href={`/projects/${encodeURIComponent(project.id)}`} prefetch={false}>Open project <span aria-hidden="true">→</span></Link>
                </div>
              </article>
            ))}
          </div>}
        </section>

        <div className="dashboard-columns">
          <section id="attention" className="section-block panel">
            <div className="section-heading">
              <div><p className="eyebrow">{operatorData.state === "available" ? "Protected decision queue" : "Synthetic decision queue"}</p><h2>Needs your attention</h2></div>
              <span className="count-pill">{scopedActionInbox.length}</span>
            </div>
            <ActionInbox items={scopedActionInbox} title="Needs your attention" />
          </section>

          <section className="section-block panel">
            <div className="section-heading">
              <div><p className="eyebrow">{operatorSnapshot ? "Protected job observation" : "Synthetic execution"}</p><h2>Running now</h2></div>
              <span className="live-label"><i /> {operatorSnapshot ? `${protectedActiveWork?.length ?? 0} observed` : "Live fixture"}</span>
            </div>
            {operatorSnapshot ? <ActiveWorkList work={protectedActiveWork ?? []} /> : <div className="running-list">
              {running.map((item) => {
                const worker = workers.find((candidate) => candidate.id === item.currentWorkerId);
                return (
                  <article key={item.id} className="running-item">
                    <div className="running-head">
                      <span className="worker-mini">{worker?.displayName.split(" ").map((word) => word[0]).join("").slice(0, 2) ?? "CR"}</span>
                      <div><small>{projectName(item.source.projectId)}</small><h3>{item.title}</h3></div>
                      <b>{item.progressPercent ?? 0}%</b>
                    </div>
                    <div className="running-progress"><i style={{ width: `${item.progressPercent ?? 0}%` }} /></div>
                    <div className="running-meta"><span>{worker?.displayName ?? "Unassigned"}</span><span>{stateLabel(item.domainState)}</span></div>
                  </article>
                );
              })}
            </div>}
          </section>
        </div>

        <section id="capacity" className="section-block capacity-panel">
          <div className="section-heading">
            <div><p className="eyebrow">CR-2 deterministic simulator</p><h2>Resolve the transcription bottleneck</h2></div>
            <span className="simulation-only">Simulation only · no command sent</span>
          </div>
          <div className="capacity-layout">
            <div className="blocker-spotlight">
              <div className="spotlight-title"><span>!</span><div><small>Critical route conflict</small><h3>Mac is rendering; Content Blooms transcription is waiting</h3></div></div>
              <p>The preferred verified MLX route has no free slot. Choose how the synthetic broker should respond.</p>
              <label htmlFor="route-scenario">Placement policy</label>
              <select
                id="route-scenario"
                value={scenarioKey}
                onChange={(event) => { setScenarioKey(event.target.value as ScenarioKey); setSimulationApplied(false); }}
              >
                <option value="automatic">Automatic — best currently eligible route</option>
                <option value="pinWindows">Pin Windows PC — provisional CUDA</option>
                <option value="pinVps">Pin VPS — slower local CPU</option>
                <option value="waitForMac">Wait for Mac — preferred verified MLX</option>
              </select>
              <button className="primary-button" type="button" onClick={() => setSimulationApplied(true)}>Run allocation simulation</button>
            </div>
            <div className={`decision-card ${simulationApplied ? "decision-applied" : ""}`} aria-live="polite">
              <div className="decision-top">
                <span>{scenario.authorityAction === "blocked" ? "Blocked" : stateLabel(scenario.authorityAction)}</span>
                <b>{scenario.estimatedDurationMinutes ? `${scenario.estimatedDurationMinutes} min` : "No ETA"}</b>
              </div>
              <h3>{scenario.selectedWorkerId ? workers.find((worker) => worker.id === scenario.selectedWorkerId)?.displayName : "No eligible worker"}</h3>
              <p>{scenario.selectedRouteId ? workers.flatMap((worker) => worker.capabilities).find((route) => route.id === scenario.selectedRouteId)?.runtime : "Adjust a hard eligibility constraint."}</p>
              <ul>{scenario.explanation.map((line) => <li key={line}>{line}</li>)}</ul>
              <div className="decision-foot">
                <span>Incremental cost <b>${(scenario.estimatedCostUsd ?? 0).toFixed(2)}</b></span>
                <span>Rejected routes <b>{scenario.rejected.length}</b></span>
              </div>
            </div>
            <div className="fairness-card">
              <small>Why Content Blooms is considered next</small>
              <h3>Weighted fair share, not a greedy queue</h3>
              {portfolioScheduleScenario.explanation.map((line) => <p key={line}>{line}</p>)}
            </div>
          </div>
        </section>

        <section id="blockers" className="section-block">
          <div className="section-heading"><div><p className="eyebrow">{operatorSnapshot ? "Protected capacity facts" : "Synthetic constraints"}</p><h2>Blockers</h2></div><span className="count-pill critical">{operatorSnapshot ? operatorSnapshot.bottlenecks.length : scopedBlockers.length}</span></div>
          {operatorSnapshot ? <BottleneckList bottlenecks={operatorSnapshot.bottlenecks} /> : <div className="blocker-grid">
            {scopedBlockers.map((item) => (
              <article key={item.id} className={`blocker-card severity-${item.severity}`}>
                <div><span>{stateLabel(item.severity)}</span><small>{projectName(item.source.projectId)}</small></div>
                <h3>{item.title}</h3>
                <p>{item.safeRemedy}</p>
                <footer><span>Owner: {stateLabel(item.responsibleRole)}</span><Link href={`/projects/${encodeURIComponent(item.source.projectId)}`} prefetch={false}>Inspect →</Link></footer>
              </article>
            ))}
          </div>}
        </section>

        <section id="workers" className="section-block panel table-panel">
          <div className="section-heading"><div><p className="eyebrow">{operatorSnapshot ? "Protected fleet projection" : "Synthetic global resources"}</p><h2>Workers</h2></div><span className="live-label"><i /> {activeWorkers} observed</span></div>
          {operatorSnapshot ? <FleetProjection workers={operatorSnapshot.fleet} /> : <div className="worker-table" role="table" aria-label="Synthetic workers">
            <div className="table-row table-head" role="row"><span>Worker</span><span>Status</span><span>Allocation</span><span>Current work</span><span>Capabilities</span><span /></div>
            {workers.map((worker) => (
              <div className="table-row" role="row" key={worker.id}>
                <span className="worker-cell"><i className={`os-${worker.os}`}>{worker.os === "macos" ? "M" : worker.os === "windows" ? "W" : "L"}</i><b>{worker.displayName}</b><small>{worker.os} · {worker.totalSlots} slots</small></span>
                <span><em className={`status-dot state-${worker.state}`} />{stateLabel(worker.state)}<small>{relativeHeartbeat(worker.lastHeartbeatAt)}</small></span>
                <span>{stateLabel(worker.allocationMode)}<small>{worker.preferredProjectIds?.length ? projectName(worker.preferredProjectIds[0]) : "Portfolio pool"}</small></span>
                <span>{worker.currentWorkItemIds?.length ? workItems.find((item) => item.id === worker.currentWorkItemIds?.[0])?.title : "Ready for work"}<small>{worker.availableSlots} free slots</small></span>
                <span><b>{worker.capabilities.length}</b><small>{worker.capabilities.filter((route) => route.verification === "verified").length} verified</small></span>
                <span><Link className="row-link" href={`/workers/${encodeURIComponent(worker.id)}`} prefetch={false} aria-label={`Open ${worker.displayName}`}>→</Link></span>
              </div>
            ))}
          </div>}
        </section>

        {operatorSnapshot && <section className="section-block panel">
          <div className="section-heading"><div><p className="eyebrow">Protected service records</p><h2>Service incidents</h2></div><span className="count-pill critical">{operatorSnapshot.serviceIncidents.filter((incident) => incident.state === "open").length}</span></div>
          <ServiceIncidentList incidents={operatorSnapshot.serviceIncidents} />
        </section>}

        {operatorSnapshot && <section id="services" className="section-block panel">
          <div className="section-heading"><div><p className="eyebrow">Protected service and schedule status</p><h2>Services and schedules</h2></div><span className="live-label"><i /> Read-only observation</span></div>
          <ServiceScheduleList services={operatorSnapshot.services.filter((service) => scopedIds.has(service.projectId))} schedules={operatorSnapshot.schedules.filter((schedule) => scopedIds.has(schedule.projectId))} />
        </section>}

        <div className="dashboard-columns lower-columns">
          <section id="agents" className="section-block panel">
            <div className="section-heading"><div><p className="eyebrow">Reasoning identities</p><h2>Agents</h2></div><span className="count-pill">{agents.length}</span></div>
            <div className="agent-grid">
              {agents.map((agent) => (
                <article key={agent.id} className="agent-card">
                  <span className={`agent-avatar agent-${agent.agentType}`}>{agent.displayName.split(" ").map((word) => word[0]).join("").slice(0, 2)}</span>
                  <div><h3>{agent.displayName}</h3><p>{stateLabel(agent.agentType)} · {stateLabel(agent.state)}</p><small>{agent.projectIds.length} project grants</small></div>
                </article>
              ))}
            </div>
          </section>

          <section id="activity" className="section-block panel">
            <div className="section-heading"><div><p className="eyebrow">Append-only view</p><h2>Recent activity</h2></div></div>
            <ol className="activity-list">
              {scopedActivity.map((event) => (
                <li key={event.id}><i className={`event-${event.tone}`} /><time>{event.time}</time><div><b>{event.actor}</b><p>{event.action}</p><small>{projectName(event.projectId)}</small></div></li>
              ))}
            </ol>
          </section>
        </div>

        <footer className="page-footer">
          <span>Control Room · {"control-room-project-adapter/v1"}</span>
          <span>{operatorSnapshot ? "Protected read projection · No project commands" : "Fixture data only · No production credentials · No live project commands"}</span>
        </footer>
      </main>

      <nav className="mobile-nav" aria-label="Mobile navigation">
        <a href="#overview"><span>⌂</span>Home</a>
        <a href="#projects"><span>▦</span>Projects</a>
        <a href="#attention"><span>◆</span>Needs me</a>
        <a href="#workers"><span>◫</span>Workers</a>
      </nav>
    </div>
  );
}
