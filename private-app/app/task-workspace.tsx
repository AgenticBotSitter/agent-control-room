"use client";
import { useEffect, useRef, useState } from "react";
import { BrowserRequestError } from "../../src/web/v1/browser-client";
import { createTaskBrowserClient, taskErrorMessage } from "../../src/web/v1/task-browser-client";
import type { TaskDetail, TaskDraft, TaskPage, TaskReceipt } from "../../src/web/v1/task-wire";
import { PrivateHeader } from "./private-header";
import { TaskCatalogPanel, TaskDetailPanel, TaskProposalForm, taskUrl } from "./task-panels";
import { PrivateTaskResults } from "./task-results";
import { createTaskReviewWorkspace, type TaskReviewWorkspace } from "../../src/web/v1/task-review-workspace";
import { createTaskVerificationWorkspace, type TaskVerificationWorkspace } from "../../src/web/v1/task-verification-workspace";
import { PrivateTaskPlanning } from "./task-planning";
import { PrivateTaskAssignment } from "./task-assignment";
import { PrivateTaskApproval } from "./task-approval";
import { TaskWorkflowGuide } from "./task-workflow-guide";

/** Read-gated child; command memory is owned by the stable keyed task page, not this subtree. */
export function TaskDetailResults({ detail, projectId, reviewWorkspace, verificationWorkspace }: {
  detail?: TaskDetail; projectId: string; reviewWorkspace: TaskReviewWorkspace; verificationWorkspace?: TaskVerificationWorkspace;
}) {
  return detail && (detail.artifacts === "configured" || detail.review === "recorded")
    ? <PrivateTaskResults key={`${projectId}:${detail.task.jobId}`} projectId={projectId}
      jobId={detail.task.jobId} reviewWorkspace={reviewWorkspace} verificationWorkspace={verificationWorkspace} /> : null;
}

export function PrivateTaskWorkspace({ projectId, jobId, after }: { projectId: string; jobId?: string; after?: string }) {
  const [client] = useState(() => createTaskBrowserClient());
  // Neither failed task-detail reads nor failed result reads may discard an unfinished review.
  const [reviewWorkspace] = useState(() => createTaskReviewWorkspace());
  const [verificationWorkspace] = useState(() => createTaskVerificationWorkspace());
  const [page, setPage] = useState<TaskPage>();
  const [detail, setDetail] = useState<TaskDetail>();
  const [draft, setDraft] = useState<TaskDraft>({ title: "", instructions: "" });
  const [error, setError] = useState<BrowserRequestError>();
  const [loading, setLoading] = useState(true), [pending, setPending] = useState(false), [refresh, setRefresh] = useState(0);
  const generation = useRef(0), busy = useRef(false), alive = useRef(true);
  const failure = (reason: unknown) => reason instanceof BrowserRequestError ? reason : new BrowserRequestError("unavailable");
  useEffect(() => {
    // Busy belongs to this effect generation: a retired request must not suppress
    // the new refresh. Old results remain fenced by live/current below.
    let live = true, readBusy = false; alive.current = true;
    const load = async () => {
      if (busy.current || readBusy) return;
      readBusy = true; const current = ++generation.current;
      try {
        const value = jobId ? await client.detail(projectId, jobId) : await client.list(projectId, after);
        if (live && current === generation.current) {
          if ("task" in value) setDetail(value); else setPage(value);
          setError(client.hasPending() ? new BrowserRequestError("uncertain") : undefined);
        }
      } catch (reason) {
        if (live && current === generation.current) { setPage(undefined); setDetail(undefined); setError(failure(reason)); }
      } finally { readBusy = false; if (live && current === generation.current) setLoading(false); }
    };
    void load();
    // Refresh only reads. Closing a browser tab, reconnecting or focusing cannot start/retry a task.
    const timer = setInterval(() => { if (!document.hidden) void load(); }, 30_000);
    const focus = () => { void load(); }; window.addEventListener("focus", focus);
    return () => { live = false; alive.current = false; clearInterval(timer); window.removeEventListener("focus", focus); };
  }, [client, projectId, jobId, after, refresh]);

  async function save(retry = false) {
    if (busy.current || !page || (!retry && !page.canPropose)) return;
    busy.current = true; generation.current++; setPending(true); setError(undefined);
    try {
      const receipt: TaskReceipt = retry ? await client.retrySave() : await client.propose(projectId, draft);
      if (alive.current) window.location.assign(taskUrl(receipt.projectId, receipt.jobId));
    } catch (reason) {
      if (alive.current) {
        const err = failure(reason); setError(err);
        if (["authentication_required", "access_denied", "not_found"].includes(err.code)) { setPage(undefined); setDetail(undefined); setDraft({ title: "", instructions: "" }); }
      }
    } finally { busy.current = false; if (alive.current) setPending(false); }
  }
  const project = detail?.project ?? page?.project;
  const refreshSaved = () => { setLoading(true); setRefresh(value => value + 1); };
  const uncertain = client.hasPending();
  return <div className="private-shell"><PrivateHeader /><main id="private-main">
    <a className="private-back" href={jobId ? taskUrl(projectId) : "/projects"}>{jobId ? "← Project tasks" : "← All projects"}</a>
    {error && <div className="private-notice" role="alert"><p>{taskErrorMessage[error.code]}</p>
      {jobId && <p>Result content has been cleared. Unfinished review text and exact pending save keys remain in this task page’s memory.
        Restore access and reopen the same result to continue. Leaving or reloading the task page discards them.</p>}
      {error.code === "authentication_required" ? <><p>Signing in again also ends Access sessions for other protected applications.</p><a href="/cdn-cgi/access/logout">Sign in again</a></>
        : <div className="private-actions"><button type="button" disabled={pending} onClick={() => setRefresh(value => value + 1)}>Refresh saved tasks</button>
          {uncertain && page && <button type="button" disabled={pending} onClick={() => { void save(true); }}>Check this exact save again</button>}</div>}</div>}
    {loading && <p role="status">Loading protected tasks…</p>}
    {project && <button type="button" disabled={loading || pending} onClick={refreshSaved}>Check latest saved status</button>}
    {project && <><div className="private-heading"><span className="private-state">{project.lifecycle}</span><h1>{project.title}</h1></div>
      <nav className="private-tabs" aria-label="Project pages"><a href={`/projects/${encodeURIComponent(projectId)}`}>Overview</a>
        <a href={taskUrl(projectId)} aria-current="page">Tasks</a><a href={`/projects/${encodeURIComponent(projectId)}/settings`}>Settings</a></nav></>}
    {page && <div className="private-columns"><TaskCatalogPanel page={page} after={after} />
      {page.canPropose ? <TaskProposalForm draft={draft} setDraft={setDraft} pending={pending} uncertain={uncertain} onSave={() => { void save(); }} />
        : <p className="private-note">{page.project.lifecycle !== "active" ? "Reopen this project before proposing more work." : "Your current access allows reading tasks, not proposing new work."}</p>}</div>}
    {detail && <TaskDetailPanel detail={detail} />}
    {detail && <TaskWorkflowGuide />}
    {jobId && <PrivateTaskPlanning detail={detail} />}
    {jobId && <PrivateTaskAssignment detail={detail} onRecorded={refreshSaved} />}
    {jobId && <PrivateTaskApproval detail={detail} />}
    <div id="task-results"><TaskDetailResults detail={detail} projectId={projectId} reviewWorkspace={reviewWorkspace} verificationWorkspace={verificationWorkspace} /></div>
    {project && <p className="private-note">Saved-state view · Refreshes every 30 seconds while visible. Use the task’s submission controls to queue signed work when configured. Refreshing this page does not submit a task.</p>}
  </main></div>;
}
