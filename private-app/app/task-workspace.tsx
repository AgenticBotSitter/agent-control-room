"use client";
import { useEffect, useRef, useState } from "react";
import { BrowserRequestError } from "../../src/web/v1/browser-client";
import { createTaskBrowserClient, taskErrorMessage } from "../../src/web/v1/task-browser-client";
import type { TaskDetail, TaskDraft, TaskPage, TaskReceipt } from "../../src/web/v1/task-wire";
import { PrivateHeader } from "./private-header";
import { TaskCatalogPanel, TaskDetailPanel, TaskProposalForm, taskUrl } from "./task-panels";
import { PrivateTaskResults } from "./task-results";

export function PrivateTaskWorkspace({ projectId, jobId, after }: { projectId: string; jobId?: string; after?: string }) {
  const [client] = useState(() => createTaskBrowserClient());
  const [page, setPage] = useState<TaskPage>();
  const [detail, setDetail] = useState<TaskDetail>();
  const [draft, setDraft] = useState<TaskDraft>({ title: "", instructions: "" });
  const [error, setError] = useState<BrowserRequestError>();
  const [loading, setLoading] = useState(true), [pending, setPending] = useState(false), [refresh, setRefresh] = useState(0);
  const generation = useRef(0), busy = useRef(false), readBusy = useRef(false), alive = useRef(true);
  const failure = (reason: unknown) => reason instanceof BrowserRequestError ? reason : new BrowserRequestError("unavailable");
  useEffect(() => {
    let live = true; alive.current = true;
    const load = async () => {
      if (busy.current || readBusy.current) return;
      readBusy.current = true; const current = ++generation.current;
      try {
        const value = jobId ? await client.detail(projectId, jobId) : await client.list(projectId, after);
        if (live && current === generation.current) {
          if ("task" in value) setDetail(value); else setPage(value);
          setError(client.hasPending() ? new BrowserRequestError("uncertain") : undefined);
        }
      } catch (reason) {
        if (live && current === generation.current) { setPage(undefined); setDetail(undefined); setError(failure(reason)); }
      } finally { readBusy.current = false; if (live && current === generation.current) setLoading(false); }
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
  const uncertain = client.hasPending();
  return <div className="private-shell"><PrivateHeader /><main id="private-main">
    <a className="private-back" href={jobId ? taskUrl(projectId) : "/projects"}>{jobId ? "← Project tasks" : "← All projects"}</a>
    {error && <div className="private-notice" role="alert"><p>{taskErrorMessage[error.code]}</p>
      {error.code === "authentication_required" ? <><p>Signing in again also ends Access sessions for other protected applications.</p><a href="/cdn-cgi/access/logout">Sign in again</a></>
        : <div className="private-actions"><button type="button" disabled={pending} onClick={() => setRefresh(value => value + 1)}>Refresh saved tasks</button>
          {uncertain && page && <button type="button" disabled={pending} onClick={() => { void save(true); }}>Check this exact save again</button>}</div>}</div>}
    {loading && <p role="status">Loading protected tasks…</p>}
    {project && <><div className="private-heading"><span className="private-state">{project.lifecycle}</span><h1>{project.title}</h1></div>
      <nav className="private-tabs" aria-label="Project pages"><a href={`/projects/${encodeURIComponent(projectId)}`}>Overview</a>
        <a href={taskUrl(projectId)} aria-current="page">Tasks</a><a href={`/projects/${encodeURIComponent(projectId)}/settings`}>Settings</a></nav></>}
    {page && <div className="private-columns"><TaskCatalogPanel page={page} after={after} />
      {page.canPropose ? <TaskProposalForm draft={draft} setDraft={setDraft} pending={pending} uncertain={uncertain} onSave={() => { void save(); }} />
        : <p className="private-note">{page.project.lifecycle !== "active" ? "Reopen this project before proposing more work." : "Your current access allows reading tasks, not proposing new work."}</p>}</div>}
    {detail && <TaskDetailPanel detail={detail} />}
    {detail && (detail.artifacts === "configured" || detail.review === "recorded") && <PrivateTaskResults key={`${projectId}:${detail.task.jobId}`} projectId={projectId} jobId={detail.task.jobId} />}
    {project && <p className="private-note">Saved-state view · Refreshes every 30 seconds while visible. Agent dispatch is not connected; no work starts from refresh or reconnect.</p>}
  </main></div>;
}
