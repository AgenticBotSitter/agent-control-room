"use client";

import { useEffect, useState } from "react";
import { createProjectBrowserClient } from "../../src/web/v1/browser-client";
import { readPrivateConnections, type PrivateConnectionSnapshot } from "../../src/web/v1/connection-browser-client";
import { readTaskAttention } from "../../src/web/v1/queue-attention-browser-client";
import { readTaskHomeActivity } from "../../src/web/v1/task-home-browser-client";
import type { TaskAttentionPage } from "../../src/web/v1/task-attention-wire";
import type { TaskHomeActivity } from "../../src/web/v1/task-home-wire";
import type { ProjectCatalogPage } from "../../src/web/v1/project-wire";
import { PrivateHeader } from "./private-header";
import { useProductDisplayName, useProductModule } from "./product-configuration";

type ReadState<T> = { state: "loading" } | { state: "ready"; value: T } | { state: "unavailable" };
export type HomeDashboardState = Readonly<{
  projects: ReadState<ProjectCatalogPage>;
  activity: ReadState<TaskHomeActivity>;
  attention: ReadState<TaskAttentionPage>;
  connections: ReadState<PrivateConnectionSnapshot>;
}>;

const loadingState: HomeDashboardState = Object.freeze({ projects: { state: "loading" }, activity: { state: "loading" },
  attention: { state: "loading" }, connections: { state: "loading" } });
const taskHref = (projectId: string, jobId: string) =>
  `/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(jobId)}`;

function Unavailable({ children }: { children: React.ReactNode }) {
  return <p className="private-note" role="status">{children} No zero count or all-clear is inferred.</p>;
}

export function HomeDashboard({ data }: { data: HomeDashboardState }) {
  return <div className="private-dashboard-grid">
    <section className="private-panel" aria-labelledby="home-active"><h2 id="home-active">Running work</h2>
      {data.activity.state === "loading" ? <p role="status">Loading saved work…</p>
        : data.activity.state === "unavailable" ? <Unavailable>Running work is unavailable.</Unavailable>
          : data.activity.value.active.length ? <ul className="private-dashboard-list">{data.activity.value.active.map(task => <li key={task.jobId}>
            <a href={taskHref(task.projectId, task.jobId)}>{task.title}</a><span>{task.state.replaceAll("_", " ")}</span></li>)}</ul>
            : <p>No running or approval-waiting work is recorded.</p>}
      {data.activity.state === "ready" && data.activity.value.additionalActiveOmitted
        ? <p className="private-note">More running work exists. Open Projects to inspect it.</p> : null}
      <a className="private-action-link" href="/projects">Open projects</a>
    </section>

    <section className="private-panel" aria-labelledby="home-attention"><h2 id="home-attention">Needs attention</h2>
      {data.attention.state === "loading" ? <p role="status">Loading saved attention items…</p>
        : data.attention.state === "unavailable" ? <Unavailable>Attention items are unavailable.</Unavailable>
          : data.attention.value.items.length ? <ul className="private-dashboard-list">{data.attention.value.items.slice(0, 5).map(item => <li key={item.task.jobId}>
            <a href={taskHref(item.task.projectId, item.task.jobId)}>{item.task.title}</a>
            <span>{item.reasons.join(" · ").replaceAll("_", " ")}</span></li>)}</ul>
            : <p>No matching task attention items were found in this checked page. This is not a fleet-wide all-clear.</p>}
      {data.attention.state === "ready" && (data.attention.value.items.length > 5 || data.attention.value.nextCursor)
        ? <p className="private-note">More attention items may be available.</p> : null}
      <a className="private-action-link" href="/needs-me">Open needs attention</a>
    </section>

    <section className="private-panel" aria-labelledby="home-results"><h2 id="home-results">Recent results</h2>
      {data.activity.state === "loading" ? <p role="status">Loading verified result records…</p>
        : data.activity.state === "unavailable" || data.activity.value.resultSource !== "configured"
          ? <Unavailable>Verified result records are unavailable.</Unavailable>
          : data.activity.value.recentResults.length ? <ul className="private-dashboard-list">{data.activity.value.recentResults.slice(0, 5).map(({ task, artifact }) =>
            <li key={artifact.artifactId}><a href={`${taskHref(task.projectId, task.jobId)}#task-results`}>{task.title}</a>
              <span>{artifact.sizeBytes.toLocaleString()} bytes · received {new Date(artifact.receivedAt).toLocaleString()}</span></li>)}</ul>
            : <p>No verified result records are available yet.</p>}
      {data.activity.state === "ready" && data.activity.value.additionalResultsOmitted
        ? <p className="private-note">More recent results exist. Open the affected projects to inspect them.</p> : null}
    </section>

    <section className="private-panel" aria-labelledby="home-workers"><h2 id="home-workers">Worker status</h2>
      {data.connections.state === "loading" ? <p role="status">Loading saved worker signals…</p>
        : data.connections.state === "unavailable" ? <Unavailable>Worker status is unavailable.</Unavailable>
          : <><p>{data.connections.value.projection.summary.connectionCount} enrolled workers · {data.connections.value.projection.summary.currentSignalCount} current signals.</p>
            <p>{data.connections.value.projection.summary.staleSignalCount} stale · {data.connections.value.projection.summary.missingSignalCount} missing · {data.connections.value.projection.summary.attentionCount} need setup or review.</p>
            {data.connections.value.telemetry === "not_configured" && <Unavailable>Signal verification is not configured.</Unavailable>}</>}
      <a className="private-action-link" href="/workers">Open workers</a>
    </section>

    <section className="private-panel private-dashboard-projects" aria-labelledby="home-projects"><h2 id="home-projects">Projects</h2>
      {data.projects.state === "loading" ? <p role="status">Loading saved projects…</p>
        : data.projects.state === "unavailable" ? <Unavailable>Projects are unavailable.</Unavailable>
          : data.projects.value.projects.length ? <ul className="private-dashboard-list">{data.projects.value.projects.slice(0, 6).map(project => <li key={project.projectId}>
            <a href={`/projects/${encodeURIComponent(project.projectId)}`}>{project.title}</a><span>{project.lifecycle.replaceAll("_", " ")}</span></li>)}</ul>
            : <p>No saved projects are visible with this access.</p>}
      {data.projects.state === "ready" && (data.projects.value.projects.length > 6 || data.projects.value.nextCursor)
        ? <p className="private-note">More projects are available in the full catalog.</p> : null}
      <a className="private-action-link" href="/projects">Open all projects</a>
    </section>
  </div>;
}

export function PrivateHome() {
  const displayName = useProductDisplayName();
  const ideaLab = useProductModule("ideaLab");
  const [projects] = useState(() => createProjectBrowserClient());
  const [data, setData] = useState<HomeDashboardState>(loadingState);
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    let live = true;
    setData(loadingState);
    const settle = <T,>(promise: Promise<T>, key: keyof HomeDashboardState) => promise.then(value => {
      if (live) setData(current => ({ ...current, [key]: { state: "ready", value } }));
    }, () => { if (live) setData(current => ({ ...current, [key]: { state: "unavailable" } })); });
    void Promise.all([settle(projects.list(), "projects"), settle(readTaskHomeActivity(), "activity"),
      settle(readTaskAttention(), "attention"), settle(readPrivateConnections(), "connections")]);
    return () => { live = false; };
  }, [generation, projects]);
  return <div className="private-shell"><PrivateHeader /><main id="private-main" tabIndex={-1}>
    <section className="private-home-intro" aria-labelledby="home-title"><p className="private-eyebrow">Private workspace</p>
      <h1 id="home-title">{displayName}</h1><p>Current saved work, results and attention from the protected Control Room services. Each section reports unavailable data instead of replacing it with a zero.</p>
      <button type="button" onClick={() => setGeneration(value => value + 1)}>Refresh dashboard</button></section>
    <HomeDashboard data={data} />
    {ideaLab && <aside className="private-note private-home-note" aria-label="Optional module"><strong>Idea Lab is optional.</strong>{" "}
      <a href="/ideas">Open Idea Lab</a> to compare ideas before promoting an approved one to a project.</aside>}
  </main></div>;
}
