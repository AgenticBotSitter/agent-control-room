"use client";

import { useEffect, useState } from "react";
import { BrowserRequestError } from "../../src/web/v1/browser-client";
import { readTaskProjectOverview } from "../../src/web/v1/task-project-overview-browser-client";
import type { TaskProjectOverview } from "../../src/web/v1/task-project-overview-wire";
import { PrivateHeader } from "./private-header";
import { ProjectNavigation } from "./project-navigation";

type ProjectTaskView = "reviews" | "activity";
type ReadState = { state: "loading" } | { state: "ready"; value: TaskProjectOverview }
  | { state: "unavailable"; code: BrowserRequestError["code"] };

function taskHref(projectId: string, jobId: string) {
  return `/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(jobId)}`;
}

function TaskLinks({ projectId, tasks }: { projectId: string; tasks: TaskProjectOverview["recent"] }) {
  return <ul className="private-dashboard-list">{tasks.map(task => <li key={task.jobId}>
    <a href={taskHref(projectId, task.jobId)}>{task.title}</a>
    <span>{task.state.replaceAll("_", " ")} · updated {new Date(task.updatedAt).toLocaleString()}</span>
  </li>)}</ul>;
}

export function ProjectTaskViewPanel({ projectId, view, state }: {
  projectId: string; view: ProjectTaskView; state: ReadState;
}) {
  const title = view === "reviews" ? "Reviews" : "Activity";
  if (state.state === "loading") return <section className="private-panel"><h2>{title}</h2>
    <p role="status">Loading this project’s saved {view}…</p></section>;
  if (state.state === "unavailable") return <section className="private-panel"><h2>{title}</h2>
    <p role="alert">{state.code === "access_denied" ? `Your current access does not include this project’s ${view}.`
      : state.code === "authentication_required" ? `Your session has ended. Sign in again to see this project’s ${view}.`
        : `This project’s ${view} are unavailable. No empty list or all-clear is inferred.`}</p></section>;
  const tasks = view === "reviews" ? state.value.awaitingReview : state.value.recent;
  const omitted = view === "reviews" ? state.value.additionalReviewsOmitted : state.value.additionalRecentOmitted;
  return <section className="private-panel"><h2>{title}</h2>
    {tasks.length ? <TaskLinks projectId={projectId} tasks={tasks} />
      : <p>{view === "reviews" ? "No task is currently recorded as waiting for approval. This does not replace other review checks."
        : "No saved task activity is recorded for this project yet."}</p>}
    {omitted && <p className="private-note">More {view} exist. Open Work to see the full saved task list.</p>}
    <a className="private-action-link" href={`/projects/${encodeURIComponent(projectId)}/tasks`}>Open project work</a>
  </section>;
}

export function PrivateProjectTaskView({ projectId, view }: { projectId: string; view: ProjectTaskView }) {
  const [state, setState] = useState<ReadState>({ state: "loading" });
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    setState({ state: "loading" });
    void readTaskProjectOverview(projectId, fetch, abort.signal).then(value => {
      if (!abort.signal.aborted) setState({ state: "ready", value });
    }, error => {
      if (!abort.signal.aborted) setState({ state: "unavailable",
        code: error instanceof BrowserRequestError ? error.code : "unavailable" });
    });
    return () => abort.abort();
  }, [projectId, generation]);
  const heading = view === "reviews" ? "Project reviews" : "Project activity";
  return <div className="private-shell"><PrivateHeader />
    <main id="private-main"><a className="private-back" href={`/projects/${encodeURIComponent(projectId)}`}>← Project overview</a>
      <div className="private-heading"><p className="private-eyebrow">Saved project record</p><h1>{heading}</h1>
        <p>{view === "reviews" ? "Open the exact task before recording any decision."
          : "This is recorded task history. Refreshing it never starts or retries work."}</p></div>
      <ProjectNavigation projectId={projectId} current={view} />
      <ProjectTaskViewPanel projectId={projectId} view={view} state={state} />
      <button type="button" onClick={() => setGeneration(value => value + 1)}>Refresh saved {view}</button>
    </main></div>;
}
