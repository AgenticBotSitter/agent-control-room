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

export type TaskGuidance = Readonly<{ heading: string; explanation: string; href?: string; action?: string;
  uncertain: boolean }>;

/** Derives navigation only. It never infers permission or grants execution authority. */
export function taskStateGuidance(detail: TaskDetail): TaskGuidance {
  const latestRun = detail.attempts[0]?.runs[0];
  const runningContradiction = detail.task.state === "running" && (detail.progressSource !== "configured" || !latestRun
    || latestRun.nativeState !== null && ["completed", "failed", "cancelled", "interrupted"].includes(latestRun.nativeState)
    || ["succeeded", "failed", "cancelled"].includes(latestRun.state));
  const uncertain = detail.task.state === "orphaned" || runningContradiction || !!latestRun && (latestRun.stale
    || latestRun.state === "disconnected" || latestRun.nativeState === "ambiguous"
    || latestRun.availability !== null && latestRun.availability !== "current");
  if (uncertain) return { heading: "Check what was already recorded", uncertain: true,
    explanation: "The latest agent information is missing, old, disconnected or uncertain. Checking reads the saved status only. It does not retry this task or send replacement work." };
  switch (detail.task.state) {
    case "proposed": return { heading: "Prepare the saved proposal", uncertain: false, href: "#task-planning",
      action: "Go to preparation", explanation: "Review the requested result and prepare a separate runnable task. This does not assign or start an agent." };
    case "ready": return { heading: "Choose an eligible machine", uncertain: false, href: "#task-assignment",
      action: "Go to assignment", explanation: "The task is prepared. Assignment reserves a machine; it does not by itself start the work." };
    case "leased": return { heading: "Review the recorded assignment", uncertain: false, href: "#task-assignment",
      action: "Go to assignment", explanation: "A machine reservation is recorded. Check its current state before approving any execution." };
    case "waiting_approval": return { heading: "Owner approval is required", uncertain: false, href: "#task-approval",
      action: "Go to approval", explanation: "Review the exact prepared request and its limits. Approval and queuing remain separate recorded steps." };
    case "succeeded": return { heading: "Review the returned result", uncertain: false, href: "#task-results",
      action: "Go to results", explanation: "The job record says the work finished. Inspect the protected result and its review evidence before accepting it." };
    case "running": return { heading: "Work is in progress", uncertain: false,
      explanation: "Control Room has current progress for this task. Checking status only reads newer saved evidence and never starts another run." };
    case "failed": return { heading: "The recorded run failed", uncertain: false,
      explanation: "Control Room will not create replacement work automatically. Check the saved evidence before deciding whether to prepare a new task." };
    case "cancelled": return { heading: "The task was cancelled", uncertain: false,
      explanation: "Cancellation is recorded. This page will not restart the task; check saved status if an outside process may still be finishing." };
    case "orphaned": return { heading: "Check what was already recorded", uncertain: true,
      explanation: "The assignment was lost. Checking reads the saved status only. It does not retry this task or send replacement work." };
    case "rejected": return { heading: "The proposal was rejected", uncertain: false,
      explanation: "No work should start from this proposal. Create a new proposal only after deciding what should change." };
    default: return detail.task.state satisfies never;
  }
}

export function TaskStateGuidance({ detail, refreshing, onRefresh }: { detail: TaskDetail; refreshing: boolean;
  onRefresh: () => void }) {
  const guidance = taskStateGuidance(detail);
  return <section className={guidance.uncertain ? "private-panel private-notice" : "private-panel"}
    aria-label="What happens next"><h2>{guidance.heading}</h2><p>{guidance.explanation}</p>
    <div className="private-actions">{guidance.href && <a href={guidance.href}>{guidance.action}</a>}
      <button type="button" disabled={refreshing} onClick={onRefresh}>{refreshing ? "Checking saved status…" : "Check latest saved status"}</button>
    </div></section>;
}

export function TaskProposalForm({ draft, setDraft, pending, preparing = false, uncertain, onSave }: { draft: TaskDraft;
  setDraft: (value: TaskDraft) => void; pending: boolean; preparing?: boolean; uncertain: boolean; onSave: () => void }) {
  return <form className="private-create" onSubmit={event => { event.preventDefault(); onSave(); }}>
    <h2>Propose a task</h2><p className="private-note">Save what you want done. Saving does not assign or start an agent.
      Open the saved task to check preparation and assignment availability.</p>
    <label htmlFor="task-title">Task title</label><input id="task-title" required maxLength={120} value={draft.title}
      disabled={pending || preparing || uncertain} onChange={event => setDraft({ ...draft, title: event.target.value })} />
    <label htmlFor="task-instructions">What should the agent deliver?</label>
    <textarea id="task-instructions" required rows={8} maxLength={4000} value={draft.instructions} disabled={pending || preparing || uncertain}
      aria-describedby="task-secrets-note" onChange={event => setDraft({ ...draft, instructions: event.target.value })} />
    <p id="task-secrets-note" className="private-note">Include the desired result and limits. Never paste passwords, tokens or private keys.</p>
    <button type="submit" disabled={pending || preparing || uncertain}>{preparing ? "Reading experiment…" : pending ? "Saving proposal…" : "Save proposal"}</button>
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
