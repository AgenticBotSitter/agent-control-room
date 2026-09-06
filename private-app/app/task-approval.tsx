"use client";
import { useEffect, useRef, useState } from "react";
import { BrowserRequestError } from "../../src/web/v1/browser-client";
import { createTaskApprovalBrowserClient, approvalErrorMessage } from "../../src/web/v1/task-approval-browser-client";
import type { TaskApprovalRead, TaskApprovalReview } from "../../src/web/v1/task-approval-wire";
import type { TaskDetail } from "../../src/web/v1/task-wire";
import { PrivateTaskSubmission } from "./task-submission";
import { createApprovalEditor, retainApprovalEditor, attachApprovalFile, type TaskApprovalEditor } from "../../src/web/v1/task-approval-editor";

export function TaskApprovalPanel({ state, review, error, pending, uncertain, fileName, onReview, onCheck, onFile, onSave }: {
  state?: TaskApprovalRead; review?: TaskApprovalReview; error?: BrowserRequestError; pending: boolean; uncertain: boolean;
  fileName: string; onReview: () => void; onCheck: () => void; onFile: (file?: File) => void; onSave: () => void;
}) {
  return <section id="task-approval" className="private-panel" aria-label="Execution approval"><h2>Execution approval</h2>
    <p>Review the task before giving it permission to run. Saving signed permission does not start an agent.</p>
    {error && <p role="alert">{approvalErrorMessage[error.code]}</p>}
    {state && <>
      {state.receipt ? <p>Signed permission recorded at {state.receipt.acceptedAt}. This is a historical receipt, not confirmation that permission is still valid or that an agent ran.</p>
        : <p>No saved signed permission was found at the last check.</p>}
      {!uncertain && !state.receipt && <button type="button" disabled={pending} onClick={onReview}>Review approval request</button>}
    </>}
    <button type="button" disabled={pending} onClick={onCheck}>Check saved approval</button>
    {review && state && !uncertain && !state.receipt && <div>
      <h3>Task to be approved</h3><p className="private-prewrap">{review.prompt}</p>
      <h3>Agent instructions</h3><p className="private-prewrap">{review.instructions || "No additional instructions."}</p>
      <p>Machine: {review.nodeId} · Model: {review.model} · Provider: {review.provider}</p>
      <p>Maximum duration: {review.durationSeconds} seconds. Reservation deadline: {review.deadline}.</p>
      <p>This request is unsigned. Secure owner signing is not connected here yet. If you already have the separately signed approval file for this task, you can save it below. Never upload a private key or password.</p>
      <label>Signed approval file<input type="file" accept="application/json,.json" disabled={pending}
        onChange={event => { onFile(event.target.files?.[0]); event.target.value = ""; }} /></label>
      {fileName && <p>Selected: {fileName}. Kept only in this tab during matching status refreshes; not uploaded until you save.</p>}
      <button type="button" disabled={pending || !fileName} onClick={onSave}>Save signed approval without starting</button>
    </div>}
  </section>;
}

export function PrivateTaskApproval({ detail }: { detail?: TaskDetail }) {
  const [client] = useState(() => createTaskApprovalBrowserClient());
  const [checked, setChecked] = useState<TaskDetail>(), [state, setState] = useState<TaskApprovalRead>();
  const [editor, setEditor] = useState<TaskApprovalEditor>(), [error, setError] = useState<BrowserRequestError>();
  const [pending, setPending] = useState(false);
  const review = editor?.review, file = editor?.file;
  const generation = useRef(0), fileGeneration = useRef(0), busy = useRef(false), alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    const current = ++generation.current; let live = true;
    if (detail?.attempts.length) void client.read(detail.task.projectId, detail.task.jobId, detail.inputDigest).then(value => {
      if (live && current === generation.current) { setChecked(detail); setState(value);
        setEditor(previous => client.hasPending() ? undefined : retainApprovalEditor(previous, detail, value));
        setError(client.hasPending() ? new BrowserRequestError("uncertain") : undefined); }
    }).catch(reason => { if (live && current === generation.current) {
      setChecked(detail); setState(undefined); setEditor(undefined);
      setError(reason instanceof BrowserRequestError ? reason : new BrowserRequestError("unavailable"));
    } });
    return () => { live = false; };
  }, [client, detail]);
  async function action(kind: "review" | "check" | "save") {
    if (!detail || checked !== detail || kind !== "check" && !state || busy.current || kind === "save" && !file) return;
    if (kind === "save" && (!state || !retainApprovalEditor(editor, detail, state))) return;
    busy.current = true; setPending(true); setError(undefined); const current = ++generation.current;
    try {
      const args = [detail.task.projectId, detail.task.jobId, detail.inputDigest] as const;
      if (kind === "review") {
        const value = await client.prepare(...args);
        if (alive.current && current === generation.current) setEditor(createApprovalEditor(detail, value));
      } else {
        if (kind === "save") await client.store(...args, file!.text);
        const value = await client.read(...args);
        if (alive.current && current === generation.current) { setState(value);
          setEditor(previous => kind === "save" || client.hasPending() ? undefined : retainApprovalEditor(previous, detail, value));
          setError(client.hasPending() ? new BrowserRequestError("uncertain") : undefined); }
      }
    } catch (reason) {
      if (alive.current && current === generation.current) {
        const next = reason instanceof BrowserRequestError ? reason : new BrowserRequestError("unavailable"); setError(next); setEditor(undefined);
        if (["authentication_required", "access_denied", "not_found", "unavailable"].includes(next.code)) setState(undefined);
      }
    } finally { busy.current = false; if (alive.current) setPending(false); }
  }
  async function choose(selected?: File) {
    const current = generation.current, selection = ++fileGeneration.current, selectedEditor = editor;
    setEditor(previous => previous ? { ...previous, file: undefined } : undefined);
    if (!selected || !detail || checked !== detail || !review || busy.current || !selectedEditor) return;
    try { if (selected.size > 24_576) throw new Error(); const text = await selected.text();
      if (new TextEncoder().encode(text).byteLength > 24_576) throw new Error();
      if (alive.current && selection === fileGeneration.current) setEditor(previous => attachApprovalFile(previous, selectedEditor, { name: selected.name, text }));
    } catch { if (alive.current && current === generation.current) setError(new BrowserRequestError("invalid_request")); }
  }
  if (!detail) return null;
  if (!detail.attempts.length) return <section id="task-approval" className="private-panel" aria-label="Execution approval"><h2>Execution approval</h2>
    <p>Execution approval is available after task preparation and assignment. No agent starts from this page automatically.</p></section>;
  const current = checked === detail;
  return <><TaskApprovalPanel state={current ? state : undefined} review={current ? review : undefined} error={current ? error : undefined}
    fileName={current ? file?.name ?? "" : ""} pending={pending} uncertain={client.hasPending()}
    onReview={() => { void action("review"); }} onCheck={() => { void action("check"); }} onSave={() => { void action("save"); }}
    onFile={selected => { void choose(selected); }} />
    {current && state?.receipt && <PrivateTaskSubmission key={`${detail.task.projectId}/${detail.task.jobId}/${detail.inputDigest}/${state.receipt.packetDigest}`}
      projectId={detail.task.projectId} jobId={detail.task.jobId} inputDigest={detail.inputDigest} packetDigest={state.receipt.packetDigest} />}</>;
}
