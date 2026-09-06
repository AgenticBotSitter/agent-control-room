"use client";
import { useEffect, useState } from "react";
import { readTaskAttention } from "../../../src/web/v1/queue-attention-browser-client";
import type { TaskAttentionPage } from "../../../src/web/v1/task-attention-wire";

const labels = { proposal: "Check proposal and planning status", approval: "Approval requested", failed: "Inspect failed task",
  orphaned: "Reconcile missing worker outcome", review: "Review result", changes_requested: "Changes requested",
  verification_blocked: "Verification needs attention", revision_limit_reached: "Revision limit reached",
  result_checks_unavailable: "Result or review checks incomplete" };

export function TaskAttentionPanel({ page }: { page: TaskAttentionPage }) {
  return <div>
    <p>Checked {page.observedAt}. Examined {page.examined} candidate tasks on this page.</p>
    {page.items.length ? <ul>{page.items.map(({ task, reasons }) => <li key={task.jobId}>
      <a href={`/projects/${encodeURIComponent(task.projectId)}/tasks/${encodeURIComponent(task.jobId)}`}>{task.title}</a>
      <p>{reasons.map(reason => labels[reason]).join(" · ")}</p>
    </li>)}</ul> : <p>No matching attention items on this page. This is not an all-clear for the fleet.</p>}
    <p>Ordinary projects: {page.sources.ordinary.replaceAll("_", " ")}. Idea projects: {page.sources.ideas.replaceAll("_", " ")}.</p>
    <p>These items come from saved task and verified review records. Queue delivery uncertainty is not yet listed by task here.
      A saved proposal may already have a separate execution plan; check its task page before planning again.
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
    <button type="button" disabled={loading} onClick={() => load()}>Refresh task inbox</button>
    {loading && <p role="status">Checking saved tasks…</p>}
    {error && <p role="alert">Task inbox unavailable. Check your session and owner permissions; no empty inbox is claimed.</p>}
    {page && <><TaskAttentionPanel page={page} />{page.nextCursor && <button type="button" disabled={loading}
      onClick={() => load(page.nextCursor!)}>Check next page</button>}</>}
  </section>;
}
