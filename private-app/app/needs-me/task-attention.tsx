"use client";
import { useEffect, useState } from "react";
import { actOnTaskBlocker, readTaskAttention } from "../../../src/web/v1/queue-attention-browser-client";
import type { TaskAttentionPage } from "../../../src/web/v1/task-attention-wire";
import type { TaskBlockerRecordV1 } from "../../../src/web/v1/task-blocker-wire";

const labels = { proposal: "Check proposal and planning status", assignment: "Check prepared task assignment", approval: "Approval requested", failed: "Inspect failed task",
  blocked: "Worker reported a blocker",
  delivery_check: "Delivery checks unavailable", submission_needed: "Check approval and submission",
  delivery_pending: "Delivery pending; receipt not recorded", delivery_uncertain: "Transmission outcome unconfirmed; do not resend",
  delivery_rejected: "Agent reported rejected delivery; inspect task",
  orphaned: "Reconcile missing worker outcome", review: "Review result", changes_requested: "Changes requested",
  verification_blocked: "Verification needs attention", revision_limit_reached: "Revision limit reached",
  result_checks_unavailable: "Result or review checks incomplete" };

function BlockerPanel({ blocker, changed }: { blocker: TaskBlockerRecordV1; changed: () => void }) {
  const [answer, setAnswer] = useState(blocker.ownerAnswer ?? "");
  const [target, setTarget] = useState(blocker.targetNodeId ?? "");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const act = async (action: Parameters<typeof actOnTaskBlocker>[3], confirmation: string) => {
    if (!window.confirm(confirmation)) return;
    setBusy(true); setError(false);
    try { await actOnTaskBlocker(blocker.projectId, blocker.jobId, blocker.blockerId, action); changed(); }
    catch { setError(true); } finally { setBusy(false); }
  };
  return <div className="private-panel">
    <p><strong>Blocker:</strong> {blocker.summary}</p>
    <p><strong>What would unblock it:</strong> {blocker.unblock}</p>
    <ul>{blocker.evidence.map((entry, index) => <li key={`${entry.label}:${index}`}><strong>{entry.label}:</strong> {entry.detail}</li>)}</ul>
    <label>Answer for the worker<input value={answer} maxLength={600} onChange={event => setAnswer(event.target.value)} /></label>
    <button type="button" disabled={busy || !answer.trim() || blocker.state === "handoff_pending" && blocker.pendingAction !== "unblock"} onClick={() => void act({ action: "unblock", answer }, "Resume this task with your answer?")}>Answer and resume</button>
    <label>Different worker ID<input value={target} maxLength={180} onChange={event => setTarget(event.target.value)} /></label>
    <button type="button" disabled={busy || !target.trim() || blocker.state === "handoff_pending" && blocker.pendingAction !== "handoff"} onClick={() => void act({ action: "handoff", targetNodeId: target }, "End the current attempt and hand this task to the selected worker?")}>Hand off task</button>
    <label>Cancellation reason<input value={reason} maxLength={600} onChange={event => setReason(event.target.value)} /></label>
    <button type="button" disabled={busy || !reason.trim()} onClick={() => void act({ action: "cancel", reason }, "Cancel this task? This cannot be resumed.")}>Cancel task</button>
    {error && <p role="alert">The blocker action was not recorded. Recheck the task, your owner access, and the selected worker.</p>}
  </div>;
}

export function TaskAttentionPanel({ page, onBlockerChanged = () => {} }: { page: TaskAttentionPage; onBlockerChanged?: () => void }) {
  return <div>
    <p>Checked {page.observedAt}. Examined {page.examined} candidate tasks on this page.</p>
    {page.items.length ? <ul>{page.items.map(({ task, reasons, urgency, category, ownerQuestion, blocker }) => <li key={task.jobId}>
      <span className="private-state">{urgency === "urgent" ? "Urgent" : urgency === "soon" ? "Soon" : "Normal"} · {category.replaceAll("_", " ")}</span>
      <a href={`/projects/${encodeURIComponent(task.projectId)}/tasks/${encodeURIComponent(task.jobId)}`}>{task.title}</a>
      <p><strong>Question for you:</strong> {ownerQuestion}</p>
      <p>{reasons.map(reason => labels[reason]).join(" · ")}</p>
      {blocker && <BlockerPanel blocker={blocker} changed={onBlockerChanged} />}
    </li>)}</ul> : <p>No matching attention items on this page. This is not an all-clear for the fleet.</p>}
    <p>Ordinary projects: {page.sources.ordinary.replaceAll("_", " ")}. Idea projects: {page.sources.ideas.replaceAll("_", " ")}.</p>
    <p>These items come from saved task and verified review records.
      {page.deliverySource === "configured" ? " Delivery status uses verified historical records; receipt does not prove execution."
        : " Task-specific delivery checks are not configured."}
      {page.planningSource === "not_configured" ? " Saved-plan checks are not configured. A proposal may already have a separate execution plan; check its task page before planning again."
        : " Proposals with a verified saved plan are excluded; their prepared tasks appear separately when they need attention."}
      Opening a task does not approve, retry or execute it.</p>
  </div>;
}

export function PrivateTaskAttention() {
  const [page, setPage] = useState<TaskAttentionPage>();
  const [cursor, setCursor] = useState<string>();
  const [generation, setGeneration] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  useEffect(() => {
    let live = true;
    void readTaskAttention(cursor).then(value => { if (live) setPage(value); }, () => { if (live) setError(true); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [cursor, generation]);
  const load = (after?: string) => { setPage(undefined); setError(false); setLoading(true); setCursor(after); setGeneration(value => value + 1); };
  return <section aria-labelledby="task-attention-heading"><h2 id="task-attention-heading">Tasks needing attention</h2>
    <button type="button" disabled={loading} onClick={() => load()}>Check saved task inbox again</button>
    {loading && <p role="status">Checking saved tasks…</p>}
    {error && <p role="alert">The saved task database or protected read could not be checked. No empty inbox is claimed and no work was started. Check your session and owner permissions, then safely check this inbox again.</p>}
    {page && <><TaskAttentionPanel page={page} onBlockerChanged={() => load()} />{page.nextCursor && <button type="button" disabled={loading}
      onClick={() => load(page.nextCursor!)}>Check next page</button>}</>}
  </section>;
}
