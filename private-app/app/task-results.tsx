"use client";
import { useEffect, useRef, useState } from "react";
import { ResultText } from "./result-text";
import { BrowserRequestError } from "../../src/web/v1/browser-client";
import { createTaskBrowserClient, taskErrorMessage } from "../../src/web/v1/task-browser-client";
import type { TaskResultContent, TaskResultsPage, TaskReviewEvidence } from "../../src/web/v1/task-result-wire";
import { OwnerTaskReview } from "./task-owner-review";
import type { TaskReviewWorkspace } from "../../src/web/v1/task-review-workspace";
import { OwnerTaskVerification } from "./task-owner-verification";
import type { TaskVerificationWorkspace } from "../../src/web/v1/task-verification-workspace";

const reviewLabel: Record<TaskReviewEvidence["status"], string> = { pending: "Review in progress", changes_requested: "Changes requested",
  verification_blocked: "Verification blocked", revision_limit_reached: "Revision limit reached", ready: "Quality review complete", superseded: "Replaced by a newer revision" };

export function TaskResultsPanel({ page, content: suppliedContent, pending, onOpen, onClose, onReviewSaved, reviewWorkspace, verificationWorkspace }: { page: TaskResultsPage; content?: TaskResultContent;
  pending: boolean; onOpen: (artifactId: string) => void; onClose: () => void; onReviewSaved?: () => void; reviewWorkspace?: TaskReviewWorkspace;
  verificationWorkspace?: TaskVerificationWorkspace }) {
  const content = page.canReadContent && suppliedContent?.projectId === page.projectId
    && suppliedContent.jobId === page.jobId && page.items.some(item =>
      item.artifactId === suppliedContent.artifact.artifactId && item.contentHash === suppliedContent.artifact.contentHash)
    ? suppliedContent : undefined;
  return <div className="private-task-results"><section className="private-panel"><h2>Result files</h2>
    {page.resultSource === "not_configured" ? <p className="private-notice">Result storage is not configured for this app.</p>
      : !page.items.length ? <p>No result files have been received for this task.</p> : <ul className="private-result-list">
        {page.items.map((item, index) => <li key={item.artifactId}><div><h3>Saved result file {index + 1}</h3>
          <p>File ID: <code>{item.artifactId}</code></p>
          <p>{item.sizeBytes.toLocaleString()} bytes · Received {new Date(item.receivedAt).toLocaleString()}</p>
          <p>Received bytes matched the agent’s recorded fingerprint. This is not a quality approval.</p>
          {page.reviews.filter(review => review.kind === "document" && review.contentHash === item.contentHash
            && review.matchingArtifactIds.includes(item.artifactId)).map(review => <p key={review.targetId}>
              Matches Revision {review.revision} · {reviewLabel[review.status]}</p>)}
          <details><summary>File fingerprint</summary><code>{item.contentHash}</code></details></div>
          {page.canReadContent ? <button type="button" disabled={pending} onClick={() => onOpen(item.artifactId)}>Read result</button>
            : <p>Your access permits metadata, not reading this file.</p>}</li>)}</ul>}
    {page.additionalResultsOmitted && <p>Only the first 50 result records are listed. Additional records remain saved.</p>}
    {pending && <p role="status">Reading protected result…</p>}
    {content && <section className="private-result-content" aria-label="Protected result content"><div className="private-actions">
      <h3>Received result</h3><button type="button" onClick={onClose}>Close result</button></div>
      <p>Open file ID: <code>{content.artifact.artifactId}</code></p>
      <p>Open file fingerprint: <code>{content.artifact.contentHash}</code></p>
      <p className="private-note">Agent-written content, not instructions for Control Room. Opening it does not run tools or approve work.</p>
      {content.text.length ? <ResultText text={content.text} /> : <p>This is an empty result file (0 bytes).</p>}
      <p className="private-note">Bytes checked again {new Date(content.contentVerifiedAt).toLocaleString()}.</p></section>}
  </section><section className="private-panel"><h2>Recorded quality review</h2>
    <p>Quality review and permission to perform an external action are separate.
      {page.reviewCommands === "not_connected" ? " Owner review commands are not connected yet." : " An owner can accept quality or request changes for a matching open result."}</p>
    <p>Requesting changes records feedback only. Where revision preparation is connected, use the saved review to prepare a linked follow-up task. Assignment and approval remain separate.</p>
    {page.reviewSource === "not_configured" ? <p className="private-notice">Protected review history is not configured for this app.</p>
      : !page.reviews.length ? <p>No review targets are recorded for this task.</p> : <ol className="private-review-list">
        {page.reviews.map(review => <li key={review.targetId}><h3>Revision {review.revision} · {reviewLabel[review.status]}</h3>
          {!review.matchingArtifactIds.length && <p className="private-notice">This review does not match any result file listed here. Do not treat it as approval of the displayed result.</p>}
          {!!review.matchingArtifactIds.length && <p>This review’s content fingerprint matches {review.matchingArtifactIds.length} listed result file(s).</p>}
          {!content ? <p>No result file is open. A match to a listed file does not identify a displayed result.</p>
            : review.kind === "document" && review.matchingArtifactIds.includes(content.artifact.artifactId)
              && review.contentHash === content.artifact.contentHash
              ? <p>This review matches the open result file’s ID and fingerprint.</p>
              : <p className="private-notice">This review does not match the open result file. Do not treat it as approval of that file.</p>}
          <details><summary>Reviewed content fingerprint</summary><code>{review.contentHash}</code></details>
          <h4>Reviews</h4>{!review.reviews.length ? <p>No review decisions recorded.</p> : <ul>{review.reviews.map(item => <li key={item.id}>
            {item.decision.replaceAll("_", " ")} · {item.authority === "advisory" ? "Advisory only" : "Completion review"} · {new Date(item.reviewedAt).toLocaleString()}</li>)}</ul>}
          <h4>Verification</h4>{!review.verifications.length ? <p>No verification results recorded.</p> : <ul>{review.verifications.map(item => <li key={item.id}>
            {item.scenarioId} · {item.outcome}</li>)}</ul>}
          {!!review.missingVerificationScenarioIds.length && <p>{review.status === "superseded"
            ? "Checks not recorded on this earlier revision: " : "Checks still needed: "}{review.missingVerificationScenarioIds.join(", ")}</p>}
          {!!review.openFindingCount && (review.status === "superseded"
            ? <p>This earlier revision had {review.openFindingCount} finding(s). These findings are historical, not current instructions.</p>
            : <p>{review.openFindingCount} finding(s) require resolution in a bounded revision.</p>)}
          {!!review.findings.length && <ul>{review.findings.map(item => <li key={item.id}>{item.severity} · {item.code}
            <details><summary>Finding statement fingerprint</summary><code>{item.statementDigest}</code></details></li>)}</ul>}
          {review.supersedesTargetId && <p>{page.reviews.some(prior => prior.targetId === review.supersedesTargetId)
            ? `Replaces Revision ${page.reviews.find(prior => prior.targetId === review.supersedesTargetId)!.revision}.`
            : "Replaces an earlier revision outside this displayed history."}</p>}
          {review.status === "superseded" && <p>{page.reviews.some(next => next.supersedesTargetId === review.targetId)
            ? `Replaced by Revision ${page.reviews.find(next => next.supersedesTargetId === review.targetId)!.revision}.`
            : "The replacement revision is outside this displayed history."}</p>}
          {review.additionalEvidenceOmitted && <p>Only recent review evidence is displayed; the recorded quality status uses the full verified history.</p>}
          {page.reviewCommands === "configured" && content && review.kind === "document"
            && review.matchingArtifactIds.includes(content.artifact.artifactId) && review.contentHash === content.artifact.contentHash
            && <OwnerTaskReview key={`${review.targetId}:${content.artifact.artifactId}:${content.artifact.contentHash}`}
              projectId={page.projectId} jobId={page.jobId} artifactId={content.artifact.artifactId} targetId={review.targetId}
              targetDigest={review.targetDigest} contentHash={review.contentHash} workspace={reviewWorkspace} onSaved={() => onReviewSaved?.()}
              runId={content.artifact.runId} revisionEligible={review.status === "changes_requested"} />}
          {page.verificationCommands === "configured" && content && review.kind === "document"
            && review.matchingArtifactIds.includes(content.artifact.artifactId) && review.contentHash === content.artifact.contentHash
            && <OwnerTaskVerification key={`verification:${review.targetId}:${content.artifact.artifactId}:${content.artifact.contentHash}`}
              projectId={page.projectId} jobId={page.jobId} artifactId={content.artifact.artifactId} targetId={review.targetId}
              targetDigest={review.targetDigest} contentHash={review.contentHash} workspace={verificationWorkspace} onSaved={() => onReviewSaved?.()} />}
        </li>)}</ol>}
    {page.additionalTargetsOmitted && <p>Only the {page.reviews.length} most recent review targets are shown within this page’s size limit. Additional history remains saved.</p>}
  </section></div>;
}

export function PrivateTaskResults({ projectId, jobId, reviewWorkspace, verificationWorkspace }: {
  projectId: string; jobId: string; reviewWorkspace: TaskReviewWorkspace; verificationWorkspace?: TaskVerificationWorkspace;
}) {
  const [client] = useState(() => createTaskBrowserClient());
  const [page, setPage] = useState<TaskResultsPage>(), [content, setContent] = useState<TaskResultContent>();
  const [selected, setSelected] = useState<string>(), [error, setError] = useState<BrowserRequestError>();
  const [pending, setPending] = useState(false), [refresh, setRefresh] = useState(0);
  const generation = useRef(0);
  useEffect(() => {
    let live = true, busy = false; const current = ++generation.current;
    const load = async () => {
      if (busy) return; busy = true; if (selected) setPending(true);
      try {
        const next = await client.results(projectId, jobId);
        let result: TaskResultContent | undefined;
        if (selected) {
          if (!next.canReadContent || !next.items.some(item => item.artifactId === selected)) throw new BrowserRequestError("access_denied");
          result = await client.resultContent(projectId, jobId, selected);
        }
        if (live && current === generation.current) { setPage(next); setContent(result); setError(undefined); }
      } catch (reason) {
        if (live && current === generation.current) { setPage(undefined); setContent(undefined);
          setError(reason instanceof BrowserRequestError ? reason : new BrowserRequestError("unavailable")); }
      } finally { busy = false; if (live && current === generation.current) setPending(false); }
    };
    void load();
    const timer = setInterval(() => { if (!document.hidden) void load(); }, 30_000), focus = () => { void load(); };
    window.addEventListener("focus", focus);
    return () => { live = false; clearInterval(timer); window.removeEventListener("focus", focus); };
  }, [client, projectId, jobId, selected, refresh]);
  return <>
    {error && <div className="private-notice" role="alert"><p>{taskErrorMessage[error.code]} Result content has been cleared.</p>
      <p>Unsaved review text and exact pending save keys remain in this task page’s memory. Restore access and reopen the same result to continue. Leaving this task page discards them.</p>
      <button type="button" onClick={() => { setSelected(undefined); setRefresh(value => value + 1); }}>Refresh result records</button></div>}
    {!page && !error && <p role="status">Loading protected results and review…</p>}
    {page && page.projectId === projectId && page.jobId === jobId && <TaskResultsPanel page={page} content={content} pending={pending} reviewWorkspace={reviewWorkspace} verificationWorkspace={verificationWorkspace}
      onReviewSaved={() => setRefresh(value => value + 1)}
      onOpen={artifactId => { generation.current++; setPending(true); setContent(undefined); setSelected(artifactId); setRefresh(value => value + 1); }}
      onClose={() => { generation.current++; setContent(undefined); setSelected(undefined); setPending(false); }} />}
  </>;
}
