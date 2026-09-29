"use client";

import { useEffect, useState } from "react";
import { createLocalPilotControlRoomClientV1 } from "../../src/local-pilot/v1/control-room-browser-client";
import type { TaskHomeActivity } from "../../src/web/v1/task-home-wire";
import type { TaskProjectOverview } from "../../src/web/v1/task-project-overview-wire";
import type { TaskProjectAgentOptions } from "../../src/web/v1/task-project-agents-wire";
import type { TaskProjectAttentionPage } from "../../src/web/v1/task-project-attention-wire";

type Read<T> = { state: "loading" } | { state: "ready"; value: T } | { state: "unavailable" };
type BoardData = { home: Read<TaskHomeActivity>; overview: Read<TaskProjectOverview>; agents: Read<TaskProjectAgentOptions>;
  inbox: Read<TaskProjectAttentionPage>; reviews: Read<TaskProjectAttentionPage> };
const loading = (): BoardData => ({ home: { state: "loading" }, overview: { state: "loading" }, agents: { state: "loading" },
  inbox: { state: "loading" }, reviews: { state: "loading" } });
const taskHref = (projectId: string, jobId: string) => `/local-preview?${new URLSearchParams({ project: projectId, job: jobId })}`;

function SavedTaskList({ projectId, tasks }: { projectId: string; tasks: readonly { projectId?: string; jobId: string; title: string; state: string }[] }) {
  return tasks.length ? <ul className="private-dashboard-list">{tasks.map(task => <li key={task.jobId}>
    <a href={taskHref(task.projectId ?? projectId, task.jobId)}>{task.title}</a><span>{task.state.replaceAll("_", " ")}</span>
  </li>)}</ul> : <p>No matching saved work is recorded in this checked view.</p>;
}

function AttentionList({ page }: { page: TaskProjectAttentionPage }) {
  return page.items.length ? <ul className="private-dashboard-list">{page.items.map(item => <li key={item.task.jobId}>
    <a href={taskHref(item.task.projectId, item.task.jobId)}>{item.task.title}</a>
    <span>{item.reasons.join(" · ").replaceAll("_", " ")}</span>
    {item.resultArtifactIds.length ? <span>Saved result available from the task page.</span> : null}
  </li>)}</ul> : <p>No matching items were found in this bounded saved view. This is not an all-clear.</p>;
}

/** A deliberately read-only local owner board. It is a compact composition of
 * canonical task projections, never a second scheduler or worker controller. */
export function LocalControlRoomWorkboard({ projectId }: { projectId?: string }) {
  // This client owns its exact, read-only local-pilot route. Do not put it
  // through the project-route adapter, which intentionally rejects all paths
  // except /api/v1/projects.
  const [client] = useState(() => createLocalPilotControlRoomClientV1());
  const [data, setData] = useState<BoardData>(loading);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let live = true; setData(loading());
    const settle = <T,>(key: keyof BoardData, read: Promise<T>) => void read.then(value => {
      if (live) setData(current => ({ ...current, [key]: { state: "ready", value } }));
    }, () => { if (live) setData(current => ({ ...current, [key]: { state: "unavailable" } })); });
    settle("home", client.home());
    if (projectId) {
      settle("overview", client.overview(projectId)); settle("agents", client.agents(projectId));
      settle("inbox", client.attention(projectId, "inbox")); settle("reviews", client.attention(projectId, "reviews"));
    } else if (live) setData(current => ({ ...current, overview: { state: "unavailable" }, agents: { state: "unavailable" },
      inbox: { state: "unavailable" }, reviews: { state: "unavailable" } }));
    return () => { live = false; };
  }, [client, projectId, refresh]);
  return <section className="private-dashboard-grid" aria-label="Local Control Room workboard">
    <section className="private-panel"><h2>{projectId ? "Current work" : "Current saved work"}</h2>
      {projectId ? data.overview.state === "ready" ? <SavedTaskList projectId={projectId} tasks={data.overview.value.current} />
        : data.overview.state === "loading" ? <p role="status">Reading saved task activity…</p>
          : <p className="private-notice">Task activity is unavailable. No empty or idle state is inferred.</p>
        : data.home.state === "ready" ? <SavedTaskList projectId="" tasks={data.home.value.active} />
          : data.home.state === "loading" ? <p role="status">Reading saved task activity…</p>
            : <p className="private-notice">Task activity is unavailable. No empty or idle state is inferred.</p>}
    </section>
    <section className="private-panel"><h2>Workers</h2>
      {projectId && data.agents.state === "ready" ? <><p>Assignment routes are not configured for this local pilot. No worker eligibility is inferred.</p>
        <p>Worker availability and capability evidence are unavailable because this repository-fake pilot has no connected worker source.</p></>
        : data.agents.state === "loading" && projectId ? <p role="status">Reading worker evidence…</p>
          : <p>Worker availability and capability evidence are unavailable until a project is selected and a connected source is configured.</p>}
      <p className="private-note">Unavailable never means idle, ready, or safe to start. This board cannot assign, start, stop, approve, or retry work.</p>
    </section>
    {projectId && <><section className="private-panel"><h2>Needs attention</h2>
      {data.inbox.state === "ready" ? <AttentionList page={data.inbox.value} /> : data.inbox.state === "loading"
        ? <p role="status">Reading saved attention…</p> : <p className="private-notice">Attention evidence is unavailable. No all-clear is inferred.</p>}
    </section><section className="private-panel"><h2>Result review</h2>
      {data.reviews.state === "ready" ? <AttentionList page={data.reviews.value} /> : data.reviews.state === "loading"
        ? <p role="status">Reading saved result review…</p> : <p className="private-notice">Result review evidence is unavailable. No all-clear is inferred.</p>}
      <p className="private-note">Open a saved task to inspect its protected result list. This board only navigates; it cannot approve a result or request a correction.</p>
    </section></>}
    <section className="private-panel"><h2>Recent results</h2>
      {data.home.state === "ready" && data.home.value.resultSource === "configured" ? data.home.value.recentResults.length
        ? <ul className="private-dashboard-list">{data.home.value.recentResults.map(({ task, artifact }) => <li key={artifact.artifactId}>
          <a href={taskHref(task.projectId, task.jobId)}>{task.title}</a><span>Saved result; open task to inspect.</span></li>)}</ul>
        : <p>No verified result records are available yet.</p>
        : data.home.state === "loading" ? <p role="status">Reading saved result records…</p>
          : <p className="private-notice">Verified result records are unavailable.</p>}
    </section>
    <section className="private-panel"><h2>Board status</h2><p>This is a local, single-computer, repository-fake workboard. It reads saved records only; no provider, real worker, scheduler, or public network is connected.</p>
      <button type="button" onClick={() => setRefresh(value => value + 1)}>Refresh saved evidence</button></section>
  </section>;
}
