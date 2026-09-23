"use client";

import { useEffect, useState } from "react";
import { readProjectAgentVisibility, type ProjectAgentVisibilityRead } from "../../src/web/v1/task-project-agents-browser-client";
import type { TaskProjectAgentOptions } from "../../src/web/v1/task-project-agents-wire";
import type { OperatorCapacityWorkerV1 } from "../../src/web/v1/operator-capacity-browser-client";
import { ConfiguredTimestamp } from "./configured-timestamp";

type State = { state: "loading" } | { state: "ready"; value: ProjectAgentVisibilityRead };

const taskHref = (projectId: string, jobId: string) =>
  `/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(jobId)}`;

function capacityText(worker: OperatorCapacityWorkerV1 | undefined): string {
  if (!worker) return "No worker observation is available from the capacity source.";
  if (worker.capacity.evidence === "measured") {
    return `${worker.state}; ${worker.capacity.value.availableSlots} of ${worker.capacity.value.totalSlots} self-reported slots available.`;
  }
  const reason = ({ not_reported: "this worker did not report capacity", observation_stale: "the observation is stale",
    observation_missing: "no current observation is recorded", source_unavailable: "the source is unavailable",
    evidence_not_served: "the source did not serve capacity evidence" } as const)[worker.capacity.reasonCode];
  return `${worker.state}; capacity unavailable because ${reason}.`;
}

function Eligibility({ value, capacity, connections }: { value: TaskProjectAgentOptions;
  capacity: ProjectAgentVisibilityRead["capacity"]; connections: ProjectAgentVisibilityRead["connections"] }) {
  if (value.eligibilitySource === "not_configured") return <section className="private-panel" aria-labelledby="project-agent-eligibility-title">
    <h2 id="project-agent-eligibility-title">Eligible workers</h2>
    <p>Task assignment is not configured for this installation. No worker eligibility is inferred.</p>
  </section>;
  return <section className="private-panel" aria-labelledby="project-agent-eligibility-title">
    <h2 id="project-agent-eligibility-title">Eligible workers</h2>
    <p>These workers are configured choices for at least one current task. Eligibility is task-specific and does not mean a worker is online, has capacity, or has permission to start.</p>
    <p className="private-note">Checked {value.tasksExamined} bounded task(s) at <time dateTime={value.observedAt}>{value.observedAt}</time>.</p>
    {value.additionalTasksOmitted && <p className="private-note">More proposed tasks exist. Their worker choices are not included in this bounded view.</p>}
    {!value.workers.length ? <p>No current task has a verified assignment choice. This does not mean that no workers are configured.</p>
      : <ul className="private-local-agent-list">{value.workers.map(worker => {
        const capacityWorker = capacity.state === "ready" ? capacity.value.workers.find(item => item.workerId === worker.nodeId) : undefined;
        return <li className="private-local-agent-card" key={worker.nodeId}><h3>{worker.label}</h3>
          <p>{worker.platform} · eligible for {worker.eligibleTasks.length} current task(s)</p>
          <h4>Eligible tasks</h4><ul>{worker.eligibleTasks.map(task => <li key={task.jobId}>
            <a href={taskHref(value.projectId, task.jobId)}>{task.title}</a>
            <span> · {task.workScope === "bounded_text_review" ? "text review only" : "configured task"}</span>
          </li>)}</ul>
          <p><strong>Last worker observation:</strong> {capacity.state === "ready" ? capacityText(capacityWorker)
            : "Capacity and availability evidence is unavailable; no status is inferred."}</p>
        </li>;
      })}</ul>}
    <p><strong>Saved connection inventory:</strong> {connections.state === "ready"
      ? `${connections.value.projection.connections.length} sanitized connection record(s) are visible installation-wide. They are not joined to workers because this browser projection intentionally hides raw node identity.`
      : "Connection inventory is unavailable with this read; no enrollment state is inferred."}</p>
    <p className="private-note">Open an exact task to reserve an eligible machine. This view cannot assign, reserve, authorize, start, cancel, or resume work.</p>
  </section>;
}

export function ProjectAgentVisibilityView({ state, projectId }: { state: State; projectId: string }) {
  if (state.state === "loading") return <section className="private-panel" aria-labelledby="project-agent-eligibility-title" aria-live="polite">
    <h2 id="project-agent-eligibility-title">Eligible workers</h2><p>Reading project eligibility, worker observations, saved connections, and current work separately.</p>
  </section>;
  const { eligibility, capacity, connections, currentWork } = state.value;
  return <>
    {eligibility.state === "ready" ? <Eligibility value={eligibility.value} capacity={capacity} connections={connections} />
      : <section className="private-panel" aria-labelledby="project-agent-eligibility-title"><h2 id="project-agent-eligibility-title">Eligible workers</h2>
        <p role="alert">{eligibility.code === "authentication_required" ? "Your session has ended. Sign in again to read worker eligibility."
          : eligibility.code === "access_denied" ? "Your current project access does not include worker eligibility."
            : "Worker eligibility is unavailable. No empty worker list or assignment permission is inferred."}</p></section>}
    <section className="private-panel" aria-labelledby="project-agent-current-work-title"><h2 id="project-agent-current-work-title">Current project work</h2>
      <p className="private-note">Current work is project-wide. Control Room does not attribute it to one worker unless a canonical worker binding is recorded.</p>
      {currentWork.state === "unavailable" ? <p role="alert">Current project work is unavailable. No idle or empty state is inferred.</p>
        : currentWork.value.current.length ? <ul className="private-dashboard-list">{currentWork.value.current.map(task => <li key={task.jobId}>
          <a href={taskHref(projectId, task.jobId)}>{task.title}</a><span>{task.state.replaceAll("_", " ")} · <ConfiguredTimestamp value={task.updatedAt} prefix="Updated" /></span>
        </li>)}</ul> : <p>No proposed, assigned, running, approval-waiting, or recovery work is recorded for this project.</p>}
      {currentWork.state === "ready" && currentWork.value.additionalCurrentOmitted
        && <p className="private-note">More current work exists. Open the full Work page.</p>}
    </section>
    <section className="private-panel" aria-labelledby="project-agent-source-status-title"><h2 id="project-agent-source-status-title">Evidence sources</h2>
      <ul><li>Eligibility: {eligibility.state === "ready" ? eligibility.value.eligibilitySource.replace("_", " ") : "unavailable"}.</li>
        <li>Worker availability and capacity: {capacity.state === "ready" ? `recorded ${capacity.value.generatedAt}` : "unavailable"}.</li>
        <li>Saved connection inventory: {connections.state === "ready" ? `recorded ${connections.value.projection.generatedAt}` : "unavailable"}.</li>
        <li>Current project work: {currentWork.state === "ready" ? `recorded ${currentWork.value.observedAt}` : "unavailable"}.</li></ul>
      <p className="private-note">These sources answer different questions. A saved connection is not eligibility; eligibility is not availability; capacity is not authority; current work is not attributed to a worker here.</p>
    </section>
  </>;
}

export function ProjectAgentWorkspace({ projectId, client = readProjectAgentVisibility }: { projectId: string;
  client?: typeof readProjectAgentVisibility }) {
  const [state, setState] = useState<State>({ state: "loading" });
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    const abort = new AbortController(); setState({ state: "loading" });
    void client(projectId, fetch, abort.signal).then(value => {
      if (!abort.signal.aborted) setState({ state: "ready", value });
    }, () => {
      if (!abort.signal.aborted) setState({ state: "ready", value: {
        eligibility: { state: "unavailable", code: "unavailable" },
        connections: { state: "unavailable", code: "unavailable" },
        capacity: { state: "unavailable", code: "request_failed" },
        currentWork: { state: "unavailable", code: "unavailable" },
      } });
    });
    return () => abort.abort();
  }, [client, generation, projectId]);
  return <><ProjectAgentVisibilityView state={state} projectId={projectId} />
    <button type="button" onClick={() => setGeneration(value => value + 1)}>Refresh agent evidence</button></>;
}
