"use client";

import { useEffect, useState } from "react";
import { readActionInboxSource, type ActionInboxSourceState } from "../../../src/web/v1/action-inbox-browser-client";
import { buildActionInbox } from "../../../src/web/v1/action-inbox";
import { BrowserRequestError } from "../../../src/web/v1/browser-client";
import { readTaskAttention } from "../../../src/web/v1/queue-attention-browser-client";
import type { TaskAttentionPage } from "../../../src/web/v1/task-attention-wire";
import { ConfiguredTimestamp } from "../configured-timestamp";

type TaskSourceState =
  | { state: "loading" }
  | { state: "available"; pages: TaskAttentionPage[]; truncated: boolean }
  | { state: "unavailable"; code: "authentication_required" | "access_denied" | "unavailable"; pages: TaskAttentionPage[] };

type OperatorSourceState = ActionInboxSourceState;

export interface ActionInboxState {
  tasks: TaskSourceState;
  operator: OperatorSourceState;
}

const kindLabels = {
  failure: "Failed run",
  blocked: "Blocked work",
  approval: "Approval needed",
  review: "Review or accept",
  notification: "Attention notification",
  preparation: "Preparation needed",
} as const;

function taskFailure(error: unknown, pages: TaskAttentionPage[] = []): Extract<TaskSourceState, { state: "unavailable" }> {
  if (error instanceof BrowserRequestError && error.code === "authentication_required")
    return { state: "unavailable", code: "authentication_required", pages };
  if (error instanceof BrowserRequestError && error.code === "access_denied")
    return { state: "unavailable", code: "access_denied", pages };
  return { state: "unavailable", code: "unavailable", pages };
}

async function readAllTaskAttention(): Promise<TaskSourceState> {
  const pages: TaskAttentionPage[] = [];
  let cursor: string | undefined;
  try {
    // Bounded cursor traversal, not a timer or polling loop. It creates one
    // globally ordered view instead of hiding urgent work on a later page.
    for (let pageNumber = 0; pageNumber < 40; pageNumber += 1) {
      const page = await readTaskAttention(cursor);
      pages.push(page);
      if (!page.nextCursor) return { state: "available", pages, truncated: false };
      if (page.nextCursor === cursor) throw new Error("repeated_cursor");
      cursor = page.nextCursor;
    }
    return { state: "available", pages, truncated: true };
  } catch (error) {
    return taskFailure(error, pages);
  }
}

function sourceError(source: "tasks" | "operator", code: string): string {
  if (code === "authentication_required") return "Your session has ended. Sign in again to see the Action Inbox.";
  if (code === "access_denied") return source === "operator"
    ? "Workspace action records need owner access."
    : "Owner access is required to read cross-project task attention.";
  return source === "tasks"
    ? "Saved task attention could not be checked. No empty inbox or all-clear is inferred."
    : "Saved attention notifications could not be checked. No empty inbox or all-clear is inferred.";
}

export function ActionInboxPanel({ data, loading: pending = false }: { data: ActionInboxState; loading?: boolean }) {
  const taskPages = data.tasks.state === "loading" ? [] : data.tasks.pages;
  const taskPage = taskPages.at(-1);
  const source = data.operator.state === "available" ? data.operator.source : undefined;
  const items = buildActionInbox(taskPages, source?.items);
  const loading = pending || data.tasks.state === "loading" || data.operator.state === "loading";
  const operatorComplete = data.operator.state === "available" ? !data.operator.source.truncated
    : data.operator.state === "unavailable" && data.operator.code === "access_denied";
  const fullyAvailable = data.tasks.state === "available" && !data.tasks.truncated && operatorComplete;
  const sharedAccessFailure = data.tasks.state === "unavailable" && data.operator.state === "unavailable"
    && data.tasks.code === data.operator.code && ["authentication_required", "access_denied"].includes(data.tasks.code)
    ? data.tasks.code : undefined;
  return <div>
    {loading ? <p role="status">Loading approvals, reviews, blocked work, failures and notifications…</p> : null}
    {sharedAccessFailure ? <p role="alert">{sourceError("tasks", sharedAccessFailure)}</p> : null}
    {!sharedAccessFailure && data.tasks.state === "unavailable" ? <p role="alert">{sourceError("tasks", data.tasks.code)}</p> : null}
    {!sharedAccessFailure && data.operator.state === "unavailable" ? data.operator.code === "access_denied"
      ? <p className="private-note">{sourceError("operator", data.operator.code)}</p>
      : <p role="alert">{sourceError("operator", data.operator.code)}</p> : null}
    {items.length ? <ol className="private-dashboard-list" aria-label="Action Inbox items">
      {items.map(item => <li key={item.key}>
        <span className="private-state">{kindLabels[item.kind]}</span>
        <strong>{item.title}</strong>
        <p>{item.summary}</p>
        <p className="private-note">Project: {item.projectId ?? "Workspace"} · <ConfiguredTimestamp value={item.observedAt} prefix="Recorded" />
          {item.expiresAt ? <> · <ConfiguredTimestamp value={item.expiresAt} prefix="Expires" /></> : " · No expiry recorded"}
          {item.blockedCount ? ` · ${item.blockedCount} blocked work item${item.blockedCount === 1 ? "" : "s"}` : ""}
          {item.deliveryState ? ` · Notification delivery ${item.deliveryState.replaceAll("_", " ")}` : ""}
          {` · ${item.evidenceCount} evidence reference${item.evidenceCount === 1 ? "" : "s"}`}</p>
        {item.availableResponses.length ? <p><strong>Recorded response options:</strong> {item.availableResponses.join(" · ")}</p> : null}
        {item.href ? <a className="private-action-link" href={item.href}>{item.actionLabel}</a>
          : <p className="private-notice">No exact in-product action route is recorded for this item. Review its saved source before responding.</p>}
      </li>)}
    </ol> : fullyAvailable ? <p>No actions are waiting in the sources you can access.</p>
      : !loading ? <p>Nothing can be shown from the sources that were successfully checked. This is not an all-clear.</p> : null}
    {taskPage ? <p className="private-note">Checked {taskPage.observedAt}. Examined {taskPages.reduce((sum, page) => sum + page.examined, 0)} task candidates.
      {data.tasks.state === "available" && data.tasks.truncated ? " The 1,000-candidate safety limit was reached; more task attention may exist."
        : data.tasks.state === "unavailable" && taskPages.length ? " Later task attention could not be checked; the already-read items remain visible."
          : " No later task-attention page was reported."}</p> : null}
    {source?.truncated ? <p role="alert">The canonical attention source reached its safety limit. More owner actions may exist.</p> : null}
  </div>;
}

export function PrivateActionInbox() {
  const [data, setData] = useState<ActionInboxState>({ tasks: { state: "loading" }, operator: { state: "loading" } });
  const [generation, setGeneration] = useState(0);
  const [pending, setPending] = useState(true);
  useEffect(() => {
    let current = true;
    const taskRead = readAllTaskAttention().then(tasks => {
      if (current) setData(value => ({ ...value, tasks }));
    });
    const operatorRead = readActionInboxSource().then(operator => {
      if (current) setData(value => ({ ...value, operator }));
    });
    void Promise.allSettled([taskRead, operatorRead]).then(() => { if (current) setPending(false); });
    return () => { current = false; };
  }, [generation]);
  const reload = () => {
    setPending(true);
    setData({ tasks: { state: "loading" }, operator: { state: "loading" } });
    setGeneration(value => value + 1);
  };
  const loading = pending || data.tasks.state === "loading" || data.operator.state === "loading";
  return <section className="private-panel" aria-labelledby="action-inbox-heading">
    <h2 id="action-inbox-heading">Action Inbox</h2>
    <p>Checked owner decisions, reviews, blocked work, failures and attention notifications across all accessible projects. Opening an item does not approve, retry, accept or start work.</p>
    <button type="button" disabled={loading} onClick={() => reload()}>Check Action Inbox again</button>
    <ActionInboxPanel data={data} loading={pending} />
  </section>;
}
