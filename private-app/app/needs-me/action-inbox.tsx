"use client";

import { useEffect, useMemo, useState } from "react";
import { useSharedTaskAttention, refreshSharedTaskAttention } from "../shared-task-attention";
import { type ActionInboxSourceState } from "../../../src/web/v1/action-inbox-browser-client";
import { buildActionInbox, type ActionInboxDisplayItem } from "../../../src/web/v1/action-inbox";
import { OwnerName } from "../owner-ui";
import { createProjectBrowserClient } from "../../../src/web/v1/browser-client";
import { type TaskAttentionSourceState } from "../../../src/web/v1/task-attention-source";
import { ConfiguredTimestamp } from "../configured-timestamp";

type OperatorSourceState = ActionInboxSourceState;

export interface ActionInboxState {
  tasks: TaskAttentionSourceState;
  operator: OperatorSourceState;
}

const kindLabels = {
  failure: "Failed run",
  blocked: "Blocked work",
  approval: "Approval needed",
  review: "Review or accept",
  notification: "Attention notification",
  preparation: "Preparation needed",
  expired: "Expired",
} as const;

function sourceError(source: "tasks" | "operator", code: string): string {
  if (code === "authentication_required") return "Your session has ended. Sign in again to see the Action Inbox.";
  if (code === "not_configured") return "This installation keeps no workspace action records; task attention above is the whole inbox.";
  if (code === "access_denied") return source === "operator"
    ? "Workspace action records are not included with Idea Lab-only access."
    : "Owner access is required to read cross-project task attention.";
  return source === "tasks"
    ? "Saved task attention could not be checked. No empty inbox or all-clear is inferred."
    : "Saved attention notifications could not be checked. No empty inbox or all-clear is inferred.";
}

export function ActionInboxPanel({ data, loading: pending = false, now = Date.now(), items: sharedItems }: { data: ActionInboxState; loading?: boolean; now?: number; items?: ActionInboxDisplayItem[] }) {
  const taskPages = data.tasks.state === "loading" ? [] : data.tasks.pages;
  const taskPage = taskPages.at(-1);
  // The last retained operator source stays visible while refreshing or after a failed
  // re-check (r6ibfix; lead rule: a re-check never blanks owner status).
  const source = data.operator.state !== "loading" ? data.operator.source : undefined;
  // Reuse the header snapshot's expiry classification across later renders (r7ipol).
  const items = useMemo(() => sharedItems ?? buildActionInbox(taskPages, source?.items, now),
    [sharedItems, taskPages, source?.items, now]);
  const [page, setPage] = useState(0);
  const pageCount = Math.max(1, Math.ceil(items.length / 25));
  const currentPage = Math.min(page, pageCount - 1);
  const visibleItems = items.slice(currentPage * 25, (currentPage + 1) * 25);
  const [projectNames, setProjectNames] = useState(() => new Map<string, string>());
  const projectIdsKey = JSON.stringify([...new Set(visibleItems.flatMap(item => item.projectId ? [item.projectId] : []))]);
  useEffect(() => {
    let current = true;
    const controller = new AbortController();
    const client = createProjectBrowserClient();
    void (async () => {
      const names = new Map<string, string>();
      for (const id of JSON.parse(projectIdsKey) as string[]) {
        try { names.set(id, (await client.get(id, controller.signal)).title); }
        catch { names.set(id, "Project name unavailable"); }
      }
      if (current) setProjectNames(names);
    })();
    return () => { current = false; controller.abort(); };
  }, [projectIdsKey, data]);
  useEffect(() => { setPage(0); }, [data]);
  const loading = pending || data.tasks.state === "loading" || data.operator.state === "loading";
  const operatorComplete = data.operator.state === "available" ? !data.operator.source.truncated
    : data.operator.state === "unavailable" && (data.operator.code === "access_denied" || data.operator.code === "not_configured");
  const fullyAvailable = !loading && data.tasks.state === "available" && !data.tasks.truncated && operatorComplete;
  const sharedAccessFailure = data.tasks.state === "unavailable" && data.operator.state === "unavailable"
    && data.tasks.code === data.operator.code && ["authentication_required", "access_denied"].includes(data.tasks.code)
    ? data.tasks.code : undefined;
  return <div>
    {loading ? <p role="status">{items.length ? "Checking" : "Loading"} approvals, reviews, blocked work, failures and notifications…</p> : null}
    {sharedAccessFailure ? <p role="alert">{sourceError("tasks", sharedAccessFailure)}</p> : null}
    {!sharedAccessFailure && data.tasks.state === "unavailable" ? <p role="alert">{sourceError("tasks", data.tasks.code)}</p> : null}
    {!sharedAccessFailure && data.operator.state === "unavailable" ? data.operator.code === "access_denied" || data.operator.code === "not_configured"
      ? <p className="private-note">{sourceError("operator", data.operator.code)}</p>
      : <p role="alert">{sourceError("operator", data.operator.code)}</p> : null}
    {items.length > 0 && (data.tasks.state === "unavailable" || data.operator.state === "unavailable" && source) ? <p role="alert">Couldn't refresh saved attention. Previously checked items remain visible; their current status is unconfirmed.</p> : null}
    {items.length ? <ol className="private-dashboard-list" aria-label="Action Inbox items">
      {visibleItems.map(item => <li key={item.key}>
        <span className="private-state">{kindLabels[item.kind]}</span>
        <strong><OwnerName>{item.title}</OwnerName></strong>
        <p>{item.summary}</p>
        <p className="private-note">Project: <OwnerName>{item.projectId ? projectNames.get(item.projectId) ?? "Loading project name…" : "Workspace"}</OwnerName> · <ConfiguredTimestamp value={item.observedAt} prefix="Recorded" />
          {item.expiresAt ? <> · <ConfiguredTimestamp value={item.expiresAt} prefix={item.kind === "expired" ? "Expired" : "Expires"} /></> : " · No expiry recorded"}
          {item.blockedCount ? ` · ${item.blockedCount} blocked work item${item.blockedCount === 1 ? "" : "s"}` : ""}
          {item.deliveryState ? ` · Notification delivery ${item.deliveryState.replaceAll("_", " ")}` : ""}
          {` · ${item.evidenceCount} evidence reference${item.evidenceCount === 1 ? "" : "s"}`}</p>
        {item.availableResponses.length ? <p><strong>Recorded response options:</strong> {item.availableResponses.join(" · ")}</p> : null}
        {item.href ? <a className="private-action-link" href={item.href}>{item.actionLabel}</a>
          : <p className="private-notice">{item.kind === "expired" ? "No saved source link is available. Open the project to check its current status."
            : "No exact in-product action route is recorded for this item. Review its saved source before responding."}</p>}
      </li>)}
    </ol> : fullyAvailable ? <p>No actions are waiting in the sources you can access.</p>
      : !loading ? <p>Nothing can be shown from the sources that were successfully checked. This is not an all-clear.</p> : null}
    {items.length > 25 ? <nav className="private-actions" aria-label="Action Inbox pages">
      <button type="button" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>Previous page</button>
      <span role="status">Page {currentPage + 1} of {pageCount} · {items.length} actions read</span>
      <button type="button" disabled={currentPage === pageCount - 1} onClick={() => setPage(currentPage + 1)}>Next page</button>
    </nav> : null}
    {taskPage ? <p className="private-note"><ConfiguredTimestamp value={taskPage.observedAt} prefix="Checked" />. Examined {taskPages.reduce((sum, page) => sum + page.examined, 0)} task candidates.
      {data.tasks.state === "available" && data.tasks.truncated ? " The 1,000-candidate safety limit was reached; more task attention may exist."
        : data.tasks.state === "unavailable" && taskPages.length ? " Later task attention could not be checked; the already-read items remain visible."
          : " No later task-attention page was reported."}</p> : null}
    {source?.truncated ? <p role="alert">The canonical attention source reached its safety limit. More owner actions may exist.</p> : null}
  </div>;
}

export function PrivateActionInbox() {
  const attention = useSharedTaskAttention(true);
  const data: ActionInboxState = attention.state === "loading" || !attention.data
    ? { tasks: { state: "loading" }, operator: { state: "loading" } } : attention.data;
  const pending = attention.state === "loading" || attention.state === "ready" && attention.value.checking === true;
  const reload = () => { void refreshSharedTaskAttention(); };
  const loading = pending || data.tasks.state === "loading" || data.operator.state === "loading";
  return <section className="private-panel" aria-labelledby="action-inbox-heading">
    <h2 id="action-inbox-heading">Action Inbox</h2>
    <p>Checked owner decisions, reviews, blocked work, failures and attention notifications across all accessible projects. Opening an item does not approve, retry, accept or start work.</p>
    <button type="button" disabled={loading} onClick={() => reload()}>Check Action Inbox again</button>
    <ActionInboxPanel data={data} loading={pending} items={attention.state === "ready" ? attention.value.items : undefined} />
  </section>;
}
