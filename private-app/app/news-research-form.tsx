"use client";
import { useEffect, useState } from "react";
import { createTaskBrowserClient, taskErrorMessage } from "../../src/web/v1/task-browser-client";
import { BrowserRequestError, browserAuthenticationRecovery } from "../../src/web/v1/browser-client";
import { readBrowserJson } from "../../src/web/v1/browser-json";
import { newsResearchPreviewSchema, newsArticleActions, type NewsArticleAction, type NewsPage } from "../../src/web/v1/news-wire";
import type { TaskDraft, TaskReceipt } from "../../src/web/v1/task-wire";
import { installNewsNavigationGuard } from "../../src/web/v1/news-navigation-guard";

export function NewsResearchForm({ projectId, story, close }: {
  projectId: string; story: NewsPage["stories"][number]; close: () => void;
}) {
  const [client] = useState(() => createTaskBrowserClient());
  const [action, setAction] = useState<NewsArticleAction>("research_brief");
  const [goal, setGoal] = useState("Check the claims in this article, explain what matters, and cite reliable sources.");
  const [draft, setDraft] = useState<TaskDraft>();
  const [receipt, setReceipt] = useState<TaskReceipt>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => installNewsNavigationGuard(window, document, () => busy || client.hasPending(),
    () => setError("Stay on this page until this exact save is resolved. It may already have completed; use ‘Check this exact save again’.")), [busy, client]);
  async function prepare() {
    if (busy || client.hasPending()) return;
    setBusy(true); setError(undefined);
    try {
      const response = await fetch(`/api/v1/projects/${encodeURIComponent(projectId)}/news/prepare`, {
        method: "POST", credentials: "same-origin", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(10_000),
        headers: { "x-requested-with": "XMLHttpRequest", "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ storyId: story.storyId, storyDigest: story.storyDigest, action, goal }),
      });
      if (!response.ok) throw new BrowserRequestError(response.status === 401 ? "authentication_required"
        : response.status === 403 ? "access_denied" : response.status === 409 ? "conflict" : "unavailable");
      const preview = newsResearchPreviewSchema.parse(await readBrowserJson(response));
      if (preview.projectId !== projectId || preview.storyId !== story.storyId || preview.storyDigest !== story.storyDigest) throw new Error();
      setDraft(preview.draft);
    } catch (reason) { setError(reason instanceof BrowserRequestError && reason.code === "authentication_required"
      ? browserAuthenticationRecovery(false)
      : "Could not prepare this draft. Check your access and goal; large source packages are not supported yet. No task was saved."); }
    finally { setBusy(false); }
  }
  async function save() {
    if (busy || !draft) return;
    setBusy(true); setError(undefined);
    try { setReceipt(await (client.hasPending() ? client.retrySave() : client.propose(projectId, draft))); }
    catch (reason) { setError(reason instanceof BrowserRequestError && reason.code === "authentication_required"
      ? browserAuthenticationRecovery(client.hasPending())
      : taskErrorMessage[reason instanceof BrowserRequestError ? reason.code : "uncertain"]); }
    finally { setBusy(false); }
  }
  return <section className="private-panel" aria-label="Prepare article research">
    <h2>{story.title}</h2>
    {receipt ? <p role="status">Task saved for review. No bot has been started. <a href={`/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(receipt.jobId)}`}>Open saved task</a></p>
      : draft ? <><h3>Review the task before saving</h3><p>{draft.title}</p><pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{draft.instructions}</pre>
        <button type="button" disabled={busy} onClick={() => void save()}>{client.hasPending() ? "Check this exact save again" : "Save proposed task"}</button>
        <button type="button" disabled={busy || client.hasPending()} onClick={() => setDraft(undefined)}>Change request</button></>
        : <form onSubmit={event => { event.preventDefault(); void prepare(); }}>
          <label>What should the agent prepare?<select value={action} disabled={busy} onChange={event => setAction(event.target.value as typeof action)}>
            {newsArticleActions.filter(item => story.verificationState === "verified" || item.id === "research_brief")
              .map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
          </select></label>
          <label>Your instructions<textarea value={goal} onChange={event => setGoal(event.target.value)} required maxLength={1200} disabled={busy} /></label>
          <p>Source links and evidence references will be included. This does not authorize execution or publication.</p>
          {story.verificationState === "review_only" ? <p>This article is unverified. The agent will be asked to verify its claims and return a research report for your review.</p> : null}
          <button type="submit" disabled={busy || !goal.trim()}>Prepare draft</button>
        </form>}
    {busy ? <p role="status">Working…</p> : null}{error ? <p role="alert">{error}</p> : null}
    <button type="button" disabled={busy || client.hasPending()} onClick={close}>{receipt ? "Back to news" : "Cancel"}</button>
  </section>;
}
