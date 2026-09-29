"use client";
import { useEffect, useState, useSyncExternalStore } from "react";
import { BrowserRequestError } from "../../src/web/v1/browser-client";
import { reviewErrorMessage } from "../../src/web/v1/task-review-browser-client";
import type { TaskReviewDraft, TaskReviewOptions } from "../../src/web/v1/task-review-wire";
import { createTaskReviewWorkspace, type TaskReviewWorkspace, type TaskReviewSession, type ReviewWorkspaceBinding } from "../../src/web/v1/task-review-workspace";
import { revisionErrorMessage, revisionRequestFromReview } from "../../src/web/v1/task-revision-browser-client";
import { OwnerRevisionPanel } from "./task-owner-revision";
import { ConfiguredTimestamp } from "./configured-timestamp";
import { usePolledRead } from "./use-polled-read";

const availability: Record<TaskReviewOptions["availability"], string> = {
  available: "Review this exact result", not_configured: "Owner review is not configured.",
  access_denied: "Your current access does not permit an owner quality decision.", project_inactive: "Reopen this project before recording a new review.",
  already_reviewed: "Your quality decision is already recorded for this revision.", target_closed: "This revision is closed for new owner decisions.",
  independence_required: "This acceptance profile requires a different independent reviewer.",
};
export function OwnerReviewPanel({ options, feedback, pending, held, onFeedback, onRecord }: {
  options: TaskReviewOptions; feedback: string; pending: boolean; held: boolean;
  onFeedback: (value: string) => void; onRecord: (decision: TaskReviewDraft["decision"], attested?: boolean) => void;
}) {
  const [attested, setAttested] = useState(false);
  return <section className="private-owner-review" aria-label="Owner quality decision"><h4>{availability[options.availability]}</h4>
    {options.ownReview && <div><p>Saved {options.ownReview.decision === "accepted" ? "quality acceptance" : "request for changes"}
      {" · "}<ConfiguredTimestamp value={options.ownReview.recordedAt} /></p>
      <p>Saved against file <code>{options.ownReview.artifactId}</code> with the matching fingerprint.</p>
      {options.ownReview.feedback && <p className="private-summary">{options.ownReview.feedback}</p>}</div>}
    <p>Review applies to file <code>{options.artifactId}</code> and fingerprint <code>{options.contentHash}</code>.</p>
    {options.canReview && <><label>Changes you want
      <textarea aria-label="Changes you want" maxLength={4096} value={feedback} disabled={pending || held}
        onChange={event => onFeedback(event.target.value)} /></label>
      <p className="private-note">Use this field when requesting changes. No passwords or secrets. Maximum 4,096 UTF-8 bytes.</p>
      {options.acceptanceAttestation && <label><input type="checkbox" checked={attested} disabled={pending || held}
        onChange={event => setAttested(event.target.checked)} /> I read it and it’s correct</label>}
      {options.acceptanceAttestation && <p className="private-note">{options.acceptanceAttestation.instructions}</p>}
      <div className="private-actions"><button type="button" disabled={pending || held || !!options.acceptanceAttestation && !attested}
        onClick={() => onRecord("accepted", attested)}>Accept</button>
        <button type="button" disabled={pending || held || !feedback.trim()} onClick={() => onRecord("changes_requested")}>Request changes</button></div></>}
    <p className="private-note">A quality decision does not authorize external actions or start another agent run. Other required checks still apply.</p>
  </section>;
}

export function OwnerTaskReview({ projectId, jobId, artifactId, targetId, targetDigest, contentHash, onSaved, workspace, runId, revisionEligible = false }: {
  projectId: string; jobId: string; artifactId: string; targetId: string; targetDigest: string; contentHash: string; onSaved: () => void;
  workspace?: TaskReviewWorkspace;
  runId?: string; revisionEligible?: boolean;
}) {
  const [fallbackWorkspace] = useState(() => createTaskReviewWorkspace());
  let session: TaskReviewSession;
  try { session = (workspace ?? fallbackWorkspace).get({ projectId, jobId, artifactId, targetId, targetDigest, contentHash }); }
  catch { return <p className="private-notice" role="alert">This task page has reached its review workspace limit.
    Existing drafts and pending saves are retained. Finish those reviews before leaving or reloading this page.</p>; }
  return <OwnerTaskReviewController key={JSON.stringify([projectId, jobId, artifactId, targetId, targetDigest, contentHash])}
    projectId={projectId} jobId={jobId} artifactId={artifactId} targetId={targetId} targetDigest={targetDigest}
    contentHash={contentHash} session={session} onSaved={onSaved} runId={runId} revisionEligible={revisionEligible} />;
}

function OwnerTaskReviewController({ projectId, jobId, artifactId, targetId, targetDigest, contentHash, session, onSaved, runId, revisionEligible }:
  ReviewWorkspaceBinding & { session: TaskReviewSession; onSaved: () => void; runId?: string; revisionEligible: boolean }) {
  const { client } = session, { feedback, pending, receipt, error: saveError } = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const { revisionPending, revisionError } = session.getSnapshot();
  const [error, setError] = useState<BrowserRequestError>(), [refresh, setRefresh] = useState(0);
  // The shared polling hook owns the schedule: it pauses while the tab is
  // hidden, refreshes on focus, never overlaps a read, and backs off when
  // nothing changes or the read fails. The local `busy` flag this replaces
  // guarded overlap but not the fixed-interval retry on failure.
  const reviewRead = usePolledRead<TaskReviewOptions>({
    key: `task-owner-review-${projectId}-${jobId}-${artifactId}-${targetId}-${refresh}`,
    baseIntervalMs: 30_000,
    dropValueOnError: true,
    read: (signal, transport) => client.options(projectId, jobId,
      { artifactId, targetId, targetDigest, contentHash }, signal, transport),
    onAccept: () => { if (!client.hasPending()) setError(undefined); },
    onFailure: (reason: unknown) => {
      setError(reason instanceof BrowserRequestError ? reason : new BrowserRequestError("unavailable")); },
  });
  const options = reviewRead.value;
  const save = async (decision?: TaskReviewDraft["decision"], attested = false) => {
    setError(undefined);
    const acceptanceAttestation = decision === "accepted" && options?.acceptanceAttestation && attested
      ? { scenarioId: options.acceptanceAttestation.scenarioId,
        instructionsDigest: options.acceptanceAttestation.instructionsDigest, confirmed: true as const }
      : undefined;
    if (await session.save(decision, acceptanceAttestation)) { setRefresh(value => value + 1); onSaved(); }
  };
  const revisionRequest = options ? revisionRequestFromReview(runId, options) : undefined;
  const revisionReceipt = revisionRequest ? session.revisionClient.savedReceipt(projectId, jobId, revisionRequest) : undefined;
  const prepareRevision = async (retry = false) => {
    if (!options || !retry && (!revisionRequest || !revisionEligible || options.revisionPlanning !== "configured")) return;
    if (await session.prepareRevision(retry ? undefined : revisionRequest)) { setRefresh(value => value + 1); onSaved(); }
  };
  return <>
    {!options && !error && <p role="status">Loading owner review…</p>}
    {options && <OwnerReviewPanel options={options} feedback={feedback} pending={pending} held={client.hasPending() || !!receipt}
      onFeedback={session.setFeedback} onRecord={(decision, attested) => { void save(decision, attested); }} />}
    {pending && <p role="status">Saving your quality decision…</p>}
    {options && receipt && <p role="status">Saved: {receipt.decision === "accepted" ? "quality acceptance" : "changes requested"}. No new work has been started.</p>}
    {error && <p role="alert">{reviewErrorMessage[error.code]}</p>}
    {saveError && <p role="alert">{reviewErrorMessage[saveError.code]}</p>}
    {options && <OwnerRevisionPanel options={options} request={revisionRequest} eligible={revisionEligible} pending={revisionPending}
      held={session.revisionClient.hasPending()} receipt={revisionReceipt}
      onPrepare={() => { void prepareRevision(); }} onCheck={() => { void prepareRevision(true); }} />}
    {options && revisionError && <p role="alert">{revisionErrorMessage[revisionError.code]}</p>}
    {!options && session.revisionClient.hasPending() && <p className="private-notice">An exact revision preparation is retained in this task page.
      Restore access to its recorded review before checking it. No agent has been started.</p>}
    {client.hasPending() && <div className="private-notice"><p>An earlier save is unresolved. Keep this task page open to retain its exact check key.</p>
      <button type="button" disabled={pending} onClick={() => { void save(); }}>Check this exact review save</button></div>}
    {error && <button type="button" disabled={pending} onClick={() => { setError(undefined); setRefresh(value => value + 1); }}>Refresh recorded review</button>}
    <p className="private-note">Closing a result keeps unfinished reviews and revision preparations in this task page’s memory. Leaving or reloading the task page discards unsaved text and pending checks, not saved decisions or tasks. Reopen its recorded review before submitting again; preparing that exact review again finds its saved revision.</p>
  </>;
}
