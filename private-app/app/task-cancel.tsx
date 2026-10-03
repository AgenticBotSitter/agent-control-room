"use client";
import { useEffect, useRef, useState } from "react";
import { BrowserRequestError } from "../../src/web/v1/browser-client";
import { createTaskCancelBrowserClient, cancelErrorMessage } from "../../src/web/v1/task-cancel-browser-client";
import type { TaskCancelReceipt } from "../../src/web/v1/task-cancel-wire";
import type { TaskDetail } from "../../src/web/v1/task-wire";

const terminalStates = new Set(["succeeded", "failed", "cancelled", "rejected"]);

export function TaskCancelPanel({ visible, confirming, receipt, error, pending, onRequestConfirm, onConfirm, onDismiss }: {
  visible: boolean; confirming: boolean; receipt?: TaskCancelReceipt; error?: BrowserRequestError; pending: boolean;
  onRequestConfirm: () => void; onConfirm: () => void; onDismiss: () => void;
}) {
  if (!visible) return null;
  return <section id="task-cancel" className="private-panel" aria-label="Cancel task"><h2>Cancel</h2>
    {receipt ? <p role="status">{receipt.effect === "cancelled"
      ? "Cancelled. The reservation was released; this task will not run."
      : "Stop requested. This task is running, and Control Room cannot confirm this worker can be interrupted mid-run. It will show as resolved once it finishes on its own or its reservation lapses."}</p>
      : confirming ? <div><p>Cancel this task? A queued task never starts. A running task cannot be confirmed stopped right away;
        the request is recorded and this page will show what actually happened.</p>
        <button type="button" disabled={pending} onClick={onConfirm}>{pending ? "Cancelling…" : "Yes, cancel this task"}</button>{" "}
        <button type="button" disabled={pending} onClick={onDismiss}>No, keep it</button></div>
        : <button type="button" onClick={onRequestConfirm}>Cancel task</button>}
    {error && <p role="alert">{cancelErrorMessage[error.code]}</p>}
  </section>;
}

/** Only offered once an attempt/lease exists (something is actually reserved or running) and the
 * task has not already reached a terminal state. Mirrors PrivateTaskAssignment's command-memory shape. */
export function PrivateTaskCancel({ detail, client: suppliedClient, onRecorded }: {
  detail?: TaskDetail; client?: ReturnType<typeof createTaskCancelBrowserClient>; onRecorded?: () => void;
}) {
  const [client] = useState(() => suppliedClient ?? createTaskCancelBrowserClient());
  const [confirming, setConfirming] = useState(false), [pending, setPending] = useState(false);
  const [receipt, setReceipt] = useState<TaskCancelReceipt>(), [error, setError] = useState<BrowserRequestError>();
  const [checkedJobId, setCheckedJobId] = useState<string>();
  const busy = useRef(false), alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (detail && detail.task.jobId !== checkedJobId) {
      setCheckedJobId(detail.task.jobId); setConfirming(false); setReceipt(undefined); setError(undefined);
    }
  }, [detail, checkedJobId]);
  if (!detail) return null;
  const visible = detail.attempts.length > 0 && !terminalStates.has(detail.task.state);
  async function confirm() {
    if (busy.current || !detail) return;
    busy.current = true; setPending(true); setError(undefined);
    try {
      const value = await client.cancel(detail!.task.projectId, detail!.task.jobId, detail!.inputDigest);
      if (alive.current) { setReceipt(value); setConfirming(false); }
      onRecorded?.();
    } catch (reason) {
      if (alive.current) setError(reason instanceof BrowserRequestError ? reason : new BrowserRequestError("unavailable"));
    } finally { busy.current = false; if (alive.current) setPending(false); }
  }
  return <TaskCancelPanel visible={visible} confirming={confirming} receipt={receipt} error={error} pending={pending}
    onRequestConfirm={() => setConfirming(true)} onConfirm={() => { void confirm(); }} onDismiss={() => setConfirming(false)} />;
}
