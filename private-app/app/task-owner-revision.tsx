"use client";
import type { TaskRevisionReceipt, TaskRevisionRequest } from "../../src/web/v1/task-revision-wire";
import type { TaskReviewOptions } from "../../src/web/v1/task-review-wire";

export function OwnerRevisionPanel({ options, request, eligible, pending, held, receipt, onPrepare, onCheck }: {
  options: TaskReviewOptions; request?: TaskRevisionRequest; eligible: boolean; pending: boolean; held: boolean;
  receipt?: TaskRevisionReceipt; onPrepare: () => void; onCheck: () => void;
}) {
  if (!request && !held) return null;
  return <section className="private-owner-review" aria-label="Prepare revised task"><h4>Follow up on your saved changes</h4>
    <p>This uses the exact changes recorded in your review, not unsaved text. Preparing a revision does not start an agent.</p>
    {receipt ? <p role="status">Revision {receipt.revisionNumber} is prepared. <a href={`/projects/${encodeURIComponent(receipt.projectId)}/tasks/${encodeURIComponent(receipt.jobId)}`}>Open revised task</a></p>
      : options.revisionPlanning !== "configured" ? <p>Revision preparation is not connected for this app.</p>
        : request && eligible && !held && <button type="button" disabled={pending} onClick={onPrepare}>Prepare revised task</button>}
    {!eligible && !receipt && !held && <p>This result is no longer awaiting a revision. Refresh its review history before continuing.</p>}
    {held && <div className="private-notice"><p>An earlier revision preparation is unresolved. Check it before preparing another.</p>
      <button type="button" disabled={pending} onClick={onCheck}>Check this exact revision preparation</button></div>}
    {pending && <p role="status">Checking revision preparation…</p>}
    <p className="private-note">The revised task needs its own assignment and approval. This action does not approve output, complete this task or authorize execution.</p>
  </section>;
}
