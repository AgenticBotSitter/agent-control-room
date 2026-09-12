"use client";
import { useEffect, useRef, useState } from "react";
import { createTaskBrowserClient, taskErrorMessage } from "../../src/web/v1/task-browser-client";
import { BrowserRequestError, browserAuthenticationRecovery } from "../../src/web/v1/browser-client";
import { readBrowserJson } from "../../src/web/v1/browser-json";
import { newsResearchPreviewSchema, newsArticleActions, type NewsArticleAction, type NewsPage } from "../../src/web/v1/news-wire";
import type { TaskDraft, TaskReceipt } from "../../src/web/v1/task-wire";
import { installNewsNavigationGuard } from "../../src/web/v1/news-navigation-guard";

type ResearchFormProps = {
  projectId: string; story: NewsPage["stories"][number]; close: () => void;
};
const formBinding = (props: ResearchFormProps) => JSON.stringify([props.projectId, props.story.storyId, props.story.storyDigest]);

export function NewsResearchForm(props: ResearchFormProps) {
  const [bound, setBound] = useState(props);
  const [held, setHeld] = useState(false);
  const changed = formBinding(props) !== formBinding(bound);
  // Keep the exact save client alive while its receipt is uncertain, but never
  // display its old draft as content for the newly requested project/story.
  useEffect(() => { if (changed && !held) setBound(props); }, [changed, held, props]);
  return <BoundNewsResearchForm key={formBinding(bound)} {...bound} close={props.close}
    obscured={changed} onHold={setHeld} />;
}

function BoundNewsResearchForm({ projectId, story, close, obscured, onHold }: ResearchFormProps & {
  obscured: boolean; onHold: (held: boolean) => void;
}) {
  const [client] = useState(() => createTaskBrowserClient());
  const [action, setAction] = useState<NewsArticleAction>("research_brief");
  const [goal, setGoal] = useState("Check the claims in this article, explain what matters, and cite reliable sources.");
  const [draft, setDraft] = useState<TaskDraft>();
  const [receipt, setReceipt] = useState<TaskReceipt>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const prepareAbort = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => prepareAbort.current?.abort(), []);
  useEffect(() => installNewsNavigationGuard(window, document, () => busy || client.hasPending(),
    () => setError("Stay on this page until this exact save is resolved. It may already have completed; use ‘Check this exact save again’.")), [busy, client]);
  async function prepare() {
    if (busy || client.hasPending()) return;
    setBusy(true); setError(undefined);
    const abort = new AbortController(); prepareAbort.current = abort;
    try {
      const response = await fetch(`/api/v1/projects/${encodeURIComponent(projectId)}/news/prepare`, {
        method: "POST", credentials: "same-origin", redirect: "error", cache: "no-store", signal: AbortSignal.any([abort.signal, AbortSignal.timeout(10_000)]),
        headers: { "x-requested-with": "XMLHttpRequest", "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ storyId: story.storyId, storyDigest: story.storyDigest, action, goal }),
      });
      if (!response.ok) throw new BrowserRequestError(response.status === 401 ? "authentication_required"
        : response.status === 403 ? "access_denied" : response.status === 409 ? "conflict" : "unavailable");
      const preview = newsResearchPreviewSchema.parse(await readBrowserJson(response));
      if (abort.signal.aborted) return;
      if (preview.projectId !== projectId || preview.storyId !== story.storyId || preview.storyDigest !== story.storyDigest) throw new Error();
      setDraft(preview.draft);
    } catch (reason) { setError(reason instanceof BrowserRequestError && reason.code === "authentication_required"
      ? browserAuthenticationRecovery(false)
      : "Could not prepare this draft. Check your access and goal; large source packages are not supported yet. No task was saved."); }
    finally { setBusy(false); }
  }
  async function save() {
    if (busy || !draft) return;
    setBusy(true); setError(undefined); onHold(true);
    try { setReceipt(await (client.hasPending() ? client.retrySave() : client.propose(projectId, draft))); }
    catch (reason) { setError(reason instanceof BrowserRequestError && reason.code === "authentication_required"
      ? browserAuthenticationRecovery(client.hasPending())
      : taskErrorMessage[reason instanceof BrowserRequestError ? reason.code : "uncertain"]); }
    finally { setBusy(false); onHold(client.hasPending()); }
  }
  if (obscured) return <section className="private-panel" aria-label="Earlier research save">
    {busy || client.hasPending() ? <><p role="status">An earlier research save belongs to a different project or story. Resolve that exact save before using this form here.</p>
      <button type="button" disabled={busy} onClick={() => void save()}>Check earlier save again</button>
      {error ? <p role="alert">{error}</p> : null}</> : <p role="status">Opening the selected article…</p>}
  </section>;
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
