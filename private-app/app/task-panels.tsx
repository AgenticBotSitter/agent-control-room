import type { TaskDetail, TaskDraft, TaskPage, TaskRun } from "../../src/web/v1/task-wire";

export const taskStateLabel: Record<TaskPage["tasks"][number]["state"], string> = {
  proposed: "Proposal saved", ready: "Ready for assignment", leased: "Assigned", running: "In progress",
  waiting_approval: "Waiting for approval", succeeded: "Job recorded complete", failed: "Job failed", cancelled: "Job cancelled",
  orphaned: "Assignment lost", rejected: "Proposal rejected",
};
const nativeLabel: Record<NonNullable<TaskRun["nativeState"]>, string> = { prepared: "Prepared", dispatching: "Starting",
  queued: "Agent queued", running: "Agent working", waiting_approval: "Agent waiting for approval", stopping: "Stop requested",
  completed: "Agent reports completion", failed: "Agent reports failure", cancelled: "Agent reports cancellation",
  interrupted: "Agent interrupted", ambiguous: "Outcome uncertain" };
const date = (value: string) => new Date(value).toLocaleString();
export const taskUrl = (projectId: string, jobId?: string) => `/projects/${encodeURIComponent(projectId)}/tasks${jobId ? `/${encodeURIComponent(jobId)}` : ""}`;

export function TaskProposalForm({ draft, setDraft, pending, uncertain, onSave }: { draft: TaskDraft;
  setDraft: (value: TaskDraft) => void; pending: boolean; uncertain: boolean; onSave: () => void }) {
  return <form className="private-create" onSubmit={event => { event.preventDefault(); onSave(); }}>
    <h2>Propose a task</h2><p className="private-note">Save what you want done. Saving does not assign or start an agent.
      Open the saved task to check preparation and assignment availability.</p>
    <label htmlFor="task-title">Task title</label><input id="task-title" required maxLength={120} value={draft.title}
      disabled={pending || uncertain} onChange={event => setDraft({ ...draft, title: event.target.value })} />
    <label htmlFor="task-instructions">What should the agent deliver?</label>
    <textarea id="task-instructions" required rows={8} maxLength={4000} value={draft.instructions} disabled={pending || uncertain}
      aria-describedby="task-secrets-note" onChange={event => setDraft({ ...draft, instructions: event.target.value })} />
    <p id="task-secrets-note" className="private-note">Include the desired result and limits. Never paste passwords, tokens or private keys.</p>
    <button type="submit" disabled={pending || uncertain}>{pending ? "Saving proposal…" : "Save proposal"}</button>
  </form>;
}

export function TaskCatalogPanel({ page, after, href = (projectId, jobId, cursor) =>
  `${taskUrl(projectId, jobId)}${cursor ? `?after=${encodeURIComponent(cursor)}` : ""}` }: {
  page: TaskPage; after?: string; href?: (projectId: string, jobId?: string, after?: string) => string }) {
  return <section aria-label="Saved tasks">
    <h2>Saved tasks</h2>
    {!page.tasks.length ? <p>{after ? "No more tasks on this page." : "No tasks have been saved for this project."}</p>
      : <ul className="private-task-list">{page.tasks.map(task => <li key={task.jobId}><a href={href(task.projectId, task.jobId)}>
        <span className="private-state">{taskStateLabel[task.state]}</span><h3>{task.title}</h3>
        <span className="private-note">Saved {date(task.createdAt)}</span><span className="private-open">View task →</span>
      </a></li>)}</ul>}
    <nav className="private-actions" aria-label="Task pages">
      {after && <a href={href(page.project.projectId)}>First page</a>}
      {page.nextCursor && <a href={href(page.project.projectId, undefined, page.nextCursor)}>Next 50 tasks</a>}
    </nav>
  </section>;
}

function RunPanel({ run }: { run: TaskRun }) {
  const retained = run.stale || run.state === "disconnected" || run.availability !== null && run.availability !== "current";
  const label = run.nativeState ? nativeLabel[run.nativeState] : run.state.replaceAll("_", " ");
  return <section className="private-run" aria-label="Agent observation">
    <h4>{run.harness} · {retained ? "Agent progress is not current" : label}</h4>
    {retained && <p className="private-notice">Not a current live signal. {run.availability ? `Availability: ${run.availability}. ` : ""}
      Last reported state: {label}.</p>}
    <p>{run.source === "legacy" ? "Legacy adapter evidence" : "Native agent evidence"} · Last observed {date(run.lastObservedAt)}</p>
    <dl className="private-task-facts"><div><dt>First observed working</dt><dd>{run.firstObservedExecutionAt ? date(run.firstObservedExecutionAt) : "Unknown"}</dd></div>
      <div><dt>Reported tokens</dt><dd>{run.usage?.totalTokens === null || run.usage?.totalTokens === undefined ? "Unknown" : run.usage.totalTokens.toLocaleString()}</dd></div>
      <div><dt>Cost</dt><dd>Unavailable — no enforced dollar limit</dd></div></dl>
    {run.cancellation !== "not_requested" && <p className="private-note">Cancellation: {run.cancellation.replaceAll("_", " ")}. This view does not prove that every process or external action has stopped.</p>}
    {run.resultClaim && <div className="private-result-claim"><h4>Result reported by the agent</h4>
      <p>{run.resultClaim.sizeBytes.toLocaleString()} bytes reported. This fingerprint is a producer claim; received files and their checks are shown separately below.</p>
      <details><summary>Reported content fingerprint</summary><code>{run.resultClaim.contentHash}</code></details></div>}
    {!!run.timeline.length && <details><summary>Received progress ({run.timeline.length}{run.earlierObservationsOmitted ? " most recent" : ""})</summary>
      <ol className="private-timeline">{run.timeline.map(point => <li key={point.version}><span>{nativeLabel[point.state]}</span>
        <time dateTime={point.observedAt}>{date(point.observedAt)}</time><span>{point.availability}</span></li>)}</ol>
      {run.earlierObservationsOmitted && <p>Earlier observations remain saved but are not shown in this view.</p>}</details>}
  </section>;
}

export function TaskDetailPanel({ detail }: { detail: TaskDetail }) {
  return <div className="private-task-detail">
    <section className="private-panel"><span className="private-state">{taskStateLabel[detail.task.state]}</span><h2>{detail.task.title}</h2>
      <h3>Requested result</h3><p className="private-summary">{detail.instructions}</p>
      <p className="private-note">Saved {date(detail.task.createdAt)} · Job record updated {date(detail.task.updatedAt)}</p>
      {detail.task.state === "proposed" && <p>This is saved proposed work, not an agent assignment.</p>}</section>
    <section className="private-panel"><h2>Agent progress</h2>
      <p>{detail.dispatch === "configured"
        ? "Task submission is configured. A recorded submission is not proof that an agent is online or has started."
        : "Task submission is not configured for this app."}</p>
      {detail.progressSource === "not_configured" && <p className="private-notice">Agent evidence is not configured for this app. Missing progress does not mean no agent work exists.</p>}
      {!detail.attempts.length && <p>No assignment attempts are recorded for this task.</p>}
      {detail.attempts.map(attempt => <section key={attempt.attemptId} className="private-attempt"><h3>Attempt {attempt.attemptNumber} · {attempt.state.replaceAll("_", " ")}</h3>
        {detail.progressSource === "configured" && !attempt.runs.length && <p>No agent observation is recorded for this attempt.</p>}
        {attempt.runs.map(run => <RunPanel key={run.runId} run={run} />)}
        {attempt.additionalRunsOmitted && <p>Only the 10 most recently created run records are shown.</p>}</section>)}
      {detail.earlierAttemptsOmitted && <p>Only the 10 most recent attempts are shown. Earlier history remains saved.</p>}
    </section>
    {detail.artifacts === "not_connected" && detail.review === "not_connected" && <section className="private-panel"><h2>Result and review</h2><p>Result content, independent checks and owner review are not connected to this page yet.</p>
      <p>Agent completion is not owner acceptance. This page cannot approve a result, start a revision, cancel work or authorize an external action.</p></section>}
  </div>;
}
