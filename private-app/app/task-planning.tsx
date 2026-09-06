"use client";
import { useEffect, useRef, useState } from "react";
import { BrowserRequestError } from "../../src/web/v1/browser-client";
import { createTaskPlanningBrowserClient, planningErrorMessage } from "../../src/web/v1/task-planning-browser-client";
import type { TaskPlanningOptions, TaskPlanningReceipt } from "../../src/web/v1/task-planning-wire";
import type { TaskDetail } from "../../src/web/v1/task-wire";
import { taskUrl } from "./task-panels";

export function TaskPlanningPanel({ options, receipt, error, pending, uncertain, onPrepare, onRetry }: {
  options?: TaskPlanningOptions; receipt?: TaskPlanningReceipt; error?: BrowserRequestError;
  pending: boolean; uncertain: boolean; onPrepare: () => void; onRetry: () => void;
}) {
  return <section id="task-planning" className="private-panel" aria-label="Prepare task"><h2>Prepare task</h2>
    <p>Preparation saves a separate execution plan. It does not approve work, assign an agent or start a run.</p>
    {error && <p role="alert">{planningErrorMessage[error.code]}</p>}
    {receipt ? <p role="status">Plan saved. <a href={taskUrl(receipt.projectId, receipt.jobId)}>Open the prepared task</a>. Saving this plan did not start an agent. Check the prepared task for current progress.</p>
      : uncertain ? <button type="button" disabled={pending} onClick={onRetry}>Check this exact preparation again</button>
      : options?.availability === "available" ? <button type="button" disabled={pending} onClick={onPrepare}>Prepare saved task</button>
      : <p className="private-note">{options?.availability === "not_configured" ? "Task preparation is not connected in this installation."
        : options?.availability === "not_eligible" ? "This task is not available for new preparation with your current access and project state."
          : "Checking task preparation availability…"}</p>}
  </section>;
}

/** Kept mounted by the task page even when a refresh loses authorization. Hide data on failed
 * reads while retaining only the exact pending command for explicit reconciliation. */
export function PrivateTaskPlanning({ detail }: { detail?: TaskDetail }) {
  const [client] = useState(() => createTaskPlanningBrowserClient());
  const [options, setOptions] = useState<TaskPlanningOptions>();
  const [receipt, setReceipt] = useState<TaskPlanningReceipt>();
  const [error, setError] = useState<BrowserRequestError>();
  const [checkedDetail, setCheckedDetail] = useState<TaskDetail>();
  const [pending, setPending] = useState(false);
  const generation = useRef(0), busy = useRef(false), alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    const current = ++generation.current; let live = true;
    if (detail) void client.options(detail.task.projectId, detail.task.jobId, detail.inputDigest).then(value => {
      if (live && current === generation.current) { setCheckedDetail(detail); setOptions(value);
        setReceipt(client.savedReceipt(detail.task.projectId, detail.task.jobId, detail.inputDigest));
        setError(client.hasPending() ? new BrowserRequestError("uncertain") : undefined); }
    }).catch(reason => { if (live && current === generation.current) { setCheckedDetail(detail); setOptions(undefined); setReceipt(undefined);
      setError(reason instanceof BrowserRequestError ? reason : new BrowserRequestError("unavailable")); } });
    return () => { live = false; };
  }, [client, detail]);
  async function prepare(retry = false) {
    if (busy.current || !detail || checkedDetail !== detail || !options || (!retry && options.availability !== "available")) return;
    busy.current = true; setPending(true); setError(undefined); const current = ++generation.current;
    try {
      const value = retry ? await client.retrySave() : await client.prepare(detail.task.projectId, detail.task.jobId, detail.inputDigest);
      // A same-source refresh may finish before this write. The confirmed receipt remains safe
      // to retain; rendering below still requires the current successful protected read.
      if (alive.current) setReceipt(value);
    } catch (reason) {
      if (alive.current && current === generation.current) {
        const error = reason instanceof BrowserRequestError ? reason : new BrowserRequestError("unavailable"); setError(error);
        if (["authentication_required", "access_denied", "not_found"].includes(error.code)) { setOptions(undefined); setReceipt(undefined); }
      }
    } finally { busy.current = false; if (alive.current) setPending(false); }
  }
  if (!detail) return null;
  const current = checkedDetail === detail;
  const visibleReceipt = current && options && receipt?.projectId === detail.task.projectId
    && receipt.sourceJobId === detail.task.jobId && receipt.sourceInputDigest === detail.inputDigest ? receipt : undefined;
  return <TaskPlanningPanel options={current ? options : undefined} receipt={visibleReceipt} error={current ? error : undefined} pending={pending}
    uncertain={current && client.hasPending() && !!options} onPrepare={() => { void prepare(); }} onRetry={() => { void prepare(true); }} />;
}
