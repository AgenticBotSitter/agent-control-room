"use client";

import { useEffect, useState } from "react";
import { BrowserRequestError } from "../../src/web/v1/browser-client";
import { readTaskProjectAttention } from "../../src/web/v1/task-project-attention-browser-client";
import type { TaskProjectAttentionPage } from "../../src/web/v1/task-project-attention-wire";
import { PrivateHeader } from "./private-header";
import { ProjectNavigation } from "./project-navigation";
import { ConfiguredTimestamp } from "./configured-timestamp";
import { taskResultHrefV1 } from "./task-results";

type Mode = "inbox" | "reviews";
type State = { state: "loading" } | { state: "ready"; value: TaskProjectAttentionPage }
  | { state: "unavailable"; code: BrowserRequestError["code"] };

const reasonLabel: Record<TaskProjectAttentionPage["items"][number]["reasons"][number], string> = {
  proposal: "Needs preparation", assignment: "Needs an assignment", approval: "Needs execution approval",
  failed: "Task failed", orphaned: "Task needs recovery", review: "Returned result needs review",
  changes_requested: "Changes were requested", verification_blocked: "Verification is blocked",
  revision_limit_reached: "Revision limit reached", result_checks_unavailable: "Result or review evidence is unavailable",
  delivery_check: "Delivery needs checking", submission_needed: "Needs submission", delivery_pending: "Delivery is pending",
  delivery_uncertain: "Delivery is uncertain", delivery_rejected: "Delivery was rejected",
};

function taskHref(projectId: string, jobId: string) {
  return `/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(jobId)}`;
}

export function ProjectResultReviewPanel({ projectId, mode, data }: { projectId: string; mode: Mode; data: State }) {
  const title = mode === "inbox" ? "Project inbox" : "Returned-result reviews";
  if (data.state === "loading") return <section className="private-panel"><h2>{title}</h2>
    <p role="status">Loading saved project attention…</p></section>;
  if (data.state === "unavailable") return <section className="private-panel"><h2>{title}</h2><p role="alert">
    {data.code === "authentication_required" ? "Your session has ended. Sign in again to see this project’s saved attention."
      : data.code === "access_denied" ? "Your current access does not include this project’s saved attention."
        : "This project’s saved attention is unavailable. No empty list or all-clear is inferred."}
  </p></section>;
  const value = data.value;
  return <section className="private-panel"><h2>{title}</h2>
    <p className="private-note">Checked {value.examined} saved task{value.examined === 1 ? "" : "s"}. <ConfiguredTimestamp value={value.observedAt} prefix="Observed" />.</p>
    {value.resultContent === "not_authorized" ? <p role="note">Review metadata is visible, but your current access does not authorize opening result content. No unusable result links are shown.</p> : null}
    {value.items.length ? <ul className="private-dashboard-list">{value.items.map(item => <li key={item.task.jobId}>
      <a href={taskHref(projectId, item.task.jobId)}>{item.task.title}</a>
      <span>{item.reasons.map(reason => reasonLabel[reason]).join(" · ")} · {item.urgency}</span>
      <span>{item.ownerQuestion}</span>
      {item.resultArtifactIds.length ? <span>Saved result: {item.resultArtifactIds.map((artifactId, index) => <span key={artifactId}>
        {index ? " · " : ""}<a href={taskResultHrefV1(projectId, item.task.jobId, artifactId)}>Open exact protected result</a>
      </span>)}</span> : item.reasons.includes("result_checks_unavailable")
        ? <span>Exact result links are withheld until the saved evidence can be inspected.</span> : null}
    </li>)}</ul> : <p>{mode === "reviews"
      ? "No returned result needing review was found in this checked page. This is not an all-clear for omitted or unavailable evidence."
      : "No saved attention was found in this checked page. This is not an all-clear for omitted or unavailable evidence."}</p>}
    {value.nextCursor ? <p><a className="private-action-link" href={`/projects/${encodeURIComponent(projectId)}/${mode}?after=${encodeURIComponent(value.nextCursor)}`}>Check next saved tasks</a></p> : null}
    {value.nextCursor || !value.items.length ? <p className="private-note"><a href={`/projects/${encodeURIComponent(projectId)}/${mode}`}>Check first saved tasks</a></p> : null}
    {mode === "reviews" ? <p className="private-note">Result review records quality decisions only. Execution approval remains a separate task decision.</p> : null}
  </section>;
}

export function PrivateProjectResultReview({ projectId, mode, after }: { projectId: string; mode: Mode; after?: string }) {
  const [data, setData] = useState<State>({ state: "loading" });
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    setData({ state: "loading" });
    void readTaskProjectAttention(projectId, mode, after, fetch, abort.signal).then(value => {
      if (!abort.signal.aborted) setData({ state: "ready", value });
    }, error => {
      if (!abort.signal.aborted) setData({ state: "unavailable", code: error instanceof BrowserRequestError ? error.code : "unavailable" });
    });
    return () => abort.abort();
  }, [projectId, mode, after, generation]);
  const heading = mode === "inbox" ? "Project inbox" : "Project result reviews";
  return <div className="private-shell"><PrivateHeader /><main id="private-main" tabIndex={-1}>
    <a className="private-back" href={`/projects/${encodeURIComponent(projectId)}`}>← Project overview</a>
    <div className="private-heading"><p className="private-eyebrow">Saved project record</p><h1>{heading}</h1>
      <p>{mode === "inbox" ? "This project-only attention list uses the same saved task classification as the workspace inbox."
        : "This page discovers saved returned-result review work, including results that are not waiting for execution approval."}</p></div>
    <ProjectNavigation projectId={projectId} current={mode} />
    <ProjectResultReviewPanel projectId={projectId} mode={mode} data={data} />
    <button type="button" onClick={() => setGeneration(value => value + 1)}>Refresh saved {mode}</button>
    <p className="private-note">Refresh and navigation only read saved records. They do not approve, retry, revise, submit, or start work.</p>
  </main></div>;
}
