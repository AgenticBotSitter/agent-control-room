"use client";

import { useEffect, useState } from "react";
import { BrowserRequestError } from "../../src/web/v1/browser-client";
import { readTaskProjectOverview } from "../../src/web/v1/task-project-overview-browser-client";
import type { TaskProjectOverview } from "../../src/web/v1/task-project-overview-wire";

type OverviewState = { state: "loading" } | { state: "ready"; value: TaskProjectOverview }
  | { state: "unavailable"; code: BrowserRequestError["code"] };
const href = (projectId: string, jobId: string) =>
  `/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(jobId)}`;

function TaskList({ projectId, tasks }: { projectId: string; tasks: TaskProjectOverview["recent"] }) {
  return <ul className="private-dashboard-list">{tasks.map(task => <li key={task.jobId}>
    <a href={href(projectId, task.jobId)}>{task.title}</a>
    <span>{task.state.replaceAll("_", " ")} · updated {new Date(task.updatedAt).toLocaleString()}</span>
  </li>)}</ul>;
}

export function ProjectOverviewActivityView({ state, projectId }: { state: OverviewState; projectId: string }) {
  if (state.state === "loading") return <section className="private-panel"><h2>Project activity</h2>
    <p role="status">Loading this project’s saved work…</p></section>;
  if (state.state === "unavailable") return <section className="private-panel"><h2>Project activity</h2>
    <p role="alert">{state.code === "access_denied" ? "Your current access does not include this project’s tasks."
      : state.code === "authentication_required" ? "Your session has ended. Sign in again to see this project’s work."
        : "This project’s task activity is unavailable. No empty project or all-clear is inferred."}</p></section>;
  const { value } = state;
  return <div className="private-dashboard-grid private-project-overview-grid">
    <section className="private-panel"><h2>Current work</h2>
      {value.current.length ? <TaskList projectId={projectId} tasks={value.current} />
        : <p>No proposed, queued, running, approval-waiting, or recovery work is recorded for this project.</p>}
      {value.additionalCurrentOmitted && <p className="private-note">More current work exists. Open the full Tasks page.</p>}
      <a className="private-action-link" href={`/projects/${encodeURIComponent(projectId)}/tasks`}>Create or open tasks</a>
    </section>
    <section className="private-panel"><h2>Waiting for approval</h2>
      {value.awaitingReview.length ? <TaskList projectId={projectId} tasks={value.awaitingReview} />
        : <p>No task is currently recorded as waiting for approval. This does not replace other review checks.</p>}
      {value.additionalReviewsOmitted && <p className="private-note">More review-waiting work exists. Open the full Tasks page.</p>}
    </section>
    <section className="private-panel private-dashboard-projects"><h2>Recent task activity</h2>
      {value.recent.length ? <TaskList projectId={projectId} tasks={value.recent} /> : <p>No saved tasks exist for this project yet.</p>}
      {value.additionalRecentOmitted && <p className="private-note">More task history exists. Open the full Tasks page.</p>}
    </section>
  </div>;
}

export function ProjectOverviewActivity({ projectId }: { projectId: string }) {
  const [state, setState] = useState<OverviewState>({ state: "loading" });
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    const abort = new AbortController(); setState({ state: "loading" });
    void readTaskProjectOverview(projectId, fetch, abort.signal).then(value => {
      if (!abort.signal.aborted) setState({ state: "ready", value });
    }, error => {
      if (!abort.signal.aborted) setState({ state: "unavailable",
        code: error instanceof BrowserRequestError ? error.code : "unavailable" });
    });
    return () => abort.abort();
  }, [projectId, generation]);
  return <><ProjectOverviewActivityView state={state} projectId={projectId} />
    <button type="button" onClick={() => setGeneration(value => value + 1)}>Refresh project activity</button></>;
}
