"use client";
import { useEffect, useRef, useState } from "react";
import { BrowserRequestError } from "../../src/web/v1/browser-client";
import { createTaskAssignmentBrowserClient, assignmentErrorMessage, reconcileAssignmentReceipt } from "../../src/web/v1/task-assignment-browser-client";
import type { TaskAssignmentOptions, TaskAssignmentReceipt } from "../../src/web/v1/task-assignment-wire";
import type { TaskDetail } from "../../src/web/v1/task-wire";

export function TaskAssignmentPanel({ options, receipt = options?.receipt, error, nodeId, setNodeId, pending, uncertain, onChange, onRetry }: {
  options?: TaskAssignmentOptions; receipt?: TaskAssignmentReceipt | null; error?: BrowserRequestError;
  nodeId: string; setNodeId: (value: string) => void; pending: boolean; uncertain: boolean;
  onChange: (action: "assign" | "expire") => void; onRetry: () => void;
}) {
  return <section id="task-assignment" className="private-panel" aria-label="Task assignment"><h2>Task assignment</h2>
    <p>Assignment reserves time on a machine. It does not start an agent. Execution approval and local checks are still required.</p>
    {error && <p role="alert">{assignmentErrorMessage[error.code]}</p>}
    {receipt && <div><p>Recorded reservation: {receipt.leaseState}. Ends {receipt.expiresAt}.</p>
      <p>{receipt.leaseCurrent ? "The reservation was current at the last check." : "The reservation is not current."} This is not proof that an agent started or stopped.</p></div>}
    {receipt?.leaseCurrent && !uncertain && <p>Next, <a href="#task-approval">check execution approval</a>. A reservation alone is not permission to run.</p>}
    {options && (uncertain ? <button type="button" disabled={pending} onClick={onRetry}>Check this exact assignment change</button>
      : receipt ? receipt.leaseState === "active" && !receipt.leaseCurrent
        ? <button type="button" disabled={pending} onClick={() => onChange("expire")}>Reconcile expired reservation</button> : null
      : options.candidates.length ? <div><p>Configured machines only. Availability and capacity are checked when you assign.</p>
        <label htmlFor="task-assignment-node">Machine</label><select id="task-assignment-node" value={nodeId} disabled={pending} onChange={event => setNodeId(event.target.value)}>
          <option value="">Choose a machine</option>{options.candidates.map(candidate => <option key={candidate.nodeId} value={candidate.nodeId}>{candidate.label} · {candidate.platform}</option>)}</select>
        <button type="button" disabled={pending || !options.candidates.some(candidate => candidate.nodeId === nodeId)} onClick={() => onChange("assign")}>Assign without starting</button></div>
        : <p>No configured machine is available for a new assignment of this task.</p>)}
  </section>;
}

/** Stable keyed page owns pending command memory; failed detail/option reads hide data and actions. */
export function PrivateTaskAssignment({ detail, onRecorded }: { detail?: TaskDetail; onRecorded?: () => void }) {
  const [client] = useState(() => createTaskAssignmentBrowserClient());
  const [options, setOptions] = useState<TaskAssignmentOptions>(), [checkedDetail, setCheckedDetail] = useState<TaskDetail>();
  const [receipt, setReceipt] = useState<TaskAssignmentReceipt>();
  const [nodeId, setNodeId] = useState(""), [error, setError] = useState<BrowserRequestError>(), [pending, setPending] = useState(false);
  const generation = useRef(0), busy = useRef(false), alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    const current = ++generation.current; let live = true;
    if (detail) void client.options(detail.task.projectId, detail.task.jobId, detail.inputDigest).then(value => {
      if (live && current === generation.current) { setCheckedDetail(detail); setOptions(value); setReceipt(previous => reconcileAssignmentReceipt(previous, value.receipt));
        setError(client.hasPending() ? new BrowserRequestError("uncertain") : undefined); }
    }).catch(reason => { if (live && current === generation.current) { setCheckedDetail(detail); setOptions(undefined);
      setError(reason instanceof BrowserRequestError ? reason : new BrowserRequestError("unavailable")); } });
    return () => { live = false; };
  }, [client, detail]);
  async function change(action: "assign" | "expire", retry = false) {
    if (busy.current || !detail || checkedDetail !== detail || !options) return;
    busy.current = true; setPending(true); setError(undefined); const current = ++generation.current;
    try {
      const value = retry ? await client.retrySave() : await client.change(detail.task.projectId, detail.task.jobId,
        { action, expectedInputDigest: detail.inputDigest, ...(action === "assign" ? { nodeId } : {}) });
      if (alive.current) { setReceipt(previous => reconcileAssignmentReceipt(previous, value)); onRecorded?.(); }
    } catch (reason) {
      if (alive.current && current === generation.current) {
        const error = reason instanceof BrowserRequestError ? reason : new BrowserRequestError("unavailable"); setError(error);
        if (["authentication_required", "access_denied", "not_found"].includes(error.code)) setOptions(undefined);
      }
    } finally { busy.current = false; if (alive.current) setPending(false); }
  }
  if (!detail) return null;
  const current = checkedDetail === detail;
  const visibleReceipt = current && options && receipt?.projectId === detail.task.projectId && receipt.jobId === detail.task.jobId
    && receipt.inputDigest === detail.inputDigest ? receipt : undefined;
  return <TaskAssignmentPanel options={current ? options : undefined} receipt={visibleReceipt} error={current ? error : undefined}
    nodeId={nodeId} setNodeId={setNodeId} pending={pending} uncertain={current && !!options && client.hasPending()}
    onChange={action => { void change(action); }} onRetry={() => { void change("assign", true); }} />;
}
