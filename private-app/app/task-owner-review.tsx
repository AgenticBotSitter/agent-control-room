"use client";
import { useEffect, useState, useSyncExternalStore } from "react";
import { BrowserRequestError } from "../../src/web/v1/browser-client";
import { reviewErrorMessage } from "../../src/web/v1/task-review-browser-client";
import type { TaskReviewDraft, TaskReviewOptions } from "../../src/web/v1/task-review-wire";
import { createTaskReviewWorkspace, type TaskReviewWorkspace, type TaskReviewSession, type ReviewWorkspaceBinding } from "../../src/web/v1/task-review-workspace";

const availability: Record<TaskReviewOptions["availability"], string> = {
  available: "Review this exact result", not_configured: "Owner review is not configured.",
  access_denied: "Your current access does not permit an owner quality decision.", project_inactive: "Reopen this project before recording a new review.",
  already_reviewed: "Your quality decision is already recorded for this revision.", target_closed: "This revision is closed for new owner decisions.",
  independence_required: "This acceptance profile requires a different independent reviewer.",
};
export function OwnerReviewPanel({ options, feedback, pending, held, onFeedback, onRecord }: {
  options: TaskReviewOptions; feedback: string; pending: boolean; held: boolean;
  onFeedback: (value: string) => void; onRecord: (decision: TaskReviewDraft["decision"]) => void;
}) {
  return <section className="private-owner-review" aria-label="Owner quality decision"><h4>{availability[options.availability]}</h4>
    {options.ownReview && <div><p>Saved {options.ownReview.decision === "accepted" ? "quality acceptance" : "request for changes"}
      {" · "}{new Date(options.ownReview.recordedAt).toLocaleString()}</p>
      <p>Saved against file <code>{options.ownReview.artifactId}</code> with the matching fingerprint.</p>
      {options.ownReview.feedback && <p className="private-summary">{options.ownReview.feedback}</p>}</div>}
    <p>Review applies to file <code>{options.artifactId}</code> and fingerprint <code>{options.contentHash}</code>.</p>
    {options.canReview && <><label>Changes you want
      <textarea aria-label="Changes you want" maxLength={4096} value={feedback} disabled={pending || held}
        onChange={event => onFeedback(event.target.value)} /></label>
      <p className="private-note">Use this field when requesting changes. No passwords or secrets. Maximum 4,096 UTF-8 bytes.</p>
      <div className="private-actions"><button type="button" disabled={pending || held} onClick={() => onRecord("accepted")}>Accept quality</button>
        <button type="button" disabled={pending || held || !feedback.trim()} onClick={() => onRecord("changes_requested")}>Request changes</button></div></>}
    <p className="private-note">A quality decision does not authorize external actions or start another agent run. Other required checks still apply.</p>
  </section>;
}

export function OwnerTaskReview({ projectId, jobId, artifactId, targetId, targetDigest, contentHash, onSaved, workspace }: {
  projectId: string; jobId: string; artifactId: string; targetId: string; targetDigest: string; contentHash: string; onSaved: () => void;
  workspace?: TaskReviewWorkspace;
}) {
  const [fallbackWorkspace] = useState(() => createTaskReviewWorkspace());
  let session: TaskReviewSession;
  try { session = (workspace ?? fallbackWorkspace).get({ projectId, jobId, artifactId, targetId, targetDigest, contentHash }); }
  catch { return <p className="private-notice" role="alert">This task page has reached its review workspace limit.
    Existing drafts and pending saves are retained. Finish those reviews before leaving or reloading this page.</p>; }
  return <OwnerTaskReviewController key={JSON.stringify([projectId, jobId, artifactId, targetId, targetDigest, contentHash])}
    projectId={projectId} jobId={jobId} artifactId={artifactId} targetId={targetId} targetDigest={targetDigest}
    contentHash={contentHash} session={session} onSaved={onSaved} />;
}

function OwnerTaskReviewController({ projectId, jobId, artifactId, targetId, targetDigest, contentHash, session, onSaved }:
  ReviewWorkspaceBinding & { session: TaskReviewSession; onSaved: () => void }) {
  const { client } = session, { feedback, pending, receipt, error: saveError } = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const [options, setOptions] = useState<TaskReviewOptions>();
  const [error, setError] = useState<BrowserRequestError>(), [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let live = true, busy = false;
    const load = async () => {
      if (busy) return; busy = true;
      try {
        const next = await client.options(projectId, jobId, { artifactId, targetId, targetDigest, contentHash });
        if (live) { setOptions(next); if (!client.hasPending()) setError(undefined); }
      } catch (reason) { if (live) { setOptions(undefined);
        setError(reason instanceof BrowserRequestError ? reason : new BrowserRequestError("unavailable")); } }
      finally { busy = false; }
    };
    void load(); const timer = setInterval(() => { if (!document.hidden) void load(); }, 30_000);
    const focus = () => { void load(); }; window.addEventListener("focus", focus);
    return () => { live = false; clearInterval(timer); window.removeEventListener("focus", focus); };
  }, [client, projectId, jobId, artifactId, targetId, targetDigest, contentHash, refresh]);
  const save = async (decision?: TaskReviewDraft["decision"]) => {
    setError(undefined);
    if (await session.save(decision)) { setRefresh(value => value + 1); onSaved(); }
  };
  return <>
    {!options && !error && <p role="status">Loading owner review…</p>}
    {options && <OwnerReviewPanel options={options} feedback={feedback} pending={pending} held={client.hasPending() || !!receipt}
      onFeedback={session.setFeedback} onRecord={decision => { void save(decision); }} />}
    {pending && <p role="status">Saving your quality decision…</p>}
    {options && receipt && <p role="status">Saved: {receipt.decision === "accepted" ? "quality acceptance" : "changes requested"}. No new work has been started.</p>}
    {error && <p role="alert">{reviewErrorMessage[error.code]}</p>}
    {saveError && <p role="alert">{reviewErrorMessage[saveError.code]}</p>}
    {client.hasPending() && <div className="private-notice"><p>An earlier save is unresolved. Keep this task page open to retain its exact check key.</p>
      <button type="button" disabled={pending} onClick={() => { void save(); }}>Check this exact review save</button></div>}
    {error && <button type="button" disabled={pending} onClick={() => { setError(undefined); setRefresh(value => value + 1); }}>Refresh recorded review</button>}
    <p className="private-note">Closing a result keeps unfinished reviews in this task page’s memory. Leaving or reloading the task page discards unsaved text and pending check keys, not saved decisions. Reopen its recorded review before submitting again.</p>
  </>;
}
