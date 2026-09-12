"use client";
import { useEffect, useRef, useState } from "react";
import { createNewsRefreshClient, type NewsRefreshDescription } from "../../src/web/v1/news-refresh-client";
import { installNewsNavigationGuard } from "../../src/web/v1/news-navigation-guard";
import { BrowserAuthenticationRecoveryError, BrowserRequestError, browserAuthenticationRecovery } from "../../src/web/v1/browser-client";
import type { NewsCollectionStatus } from "../../src/web/v1/news-collection-status-wire";
import { createNewsStatusObserver } from "../../src/web/v1/news-status-observer";
import { NewsCollectionHistoryBrowser } from "./news-collection-history";

export function NewsCollectionProgress({ status }: { status: NewsCollectionStatus }) {
  if (!status.configured) return <p>Collection status is not configured. Saved articles remain available.</p>;
  if (!status.latest) return <p>No retained collection request was found for this source.</p>;
  const current = status.latest;
  const labels = { prepared: "Prepared — not approved", queued: "Queued for collection", running: "Collection in progress",
    completed: "Collection completed", failed: "Collection failed", cancelled: "Collection cancelled", uncertain: "Collection outcome uncertain — do not repeat the request" };
  return <div aria-label="Saved collection progress"><p role="status">{labels[current.state]}</p>
    <p>Last saved update: <time dateTime={current.updatedAt}>{current.updatedAt}</time>. Status checked: <time dateTime={status.observedAt}>{status.observedAt}</time>.</p>
    <p style={{ overflowWrap: "anywhere" }}>Job: {current.jobId}</p>
    {current.state === "completed" ? <p>A successful check may find zero new articles. <a href={`/projects/${encodeURIComponent(status.projectId)}/news`}>Open saved news</a></p> : null}
    <p>This reads retained records, not a live connection check. It never approves or repeats collection.</p>
  </div>;
}

export function NewsSourceRefresh({ projectId, sourceId, disabled, onHold }: {
  projectId: string; sourceId: string; disabled: boolean; onHold: (held: boolean) => void;
}) {
  const [client] = useState(() => createNewsRefreshClient(projectId, sourceId));
  const [description, setDescription] = useState<NewsRefreshDescription>();
  const [state, setState] = useState(client.state), [busy, setBusy] = useState(false), [error, setError] = useState<string>();
  const [status, setStatus] = useState<NewsCollectionStatus>(), [statusError, setStatusError] = useState<string>();
  const [statusRefresh, setStatusRefresh] = useState(0);
  const [selectedJob, setSelectedJob] = useState<string>();
  const statusJob = selectedJob ?? state.jobId;
  const observer = useRef<ReturnType<typeof createNewsStatusObserver> | undefined>(undefined);
  useEffect(() => {
    // Discover once, then observe that exact run rather than rescanning the
    // whole signed project history every five seconds.
    let observedJob = statusJob;
    const current = createNewsStatusObserver({ read: signal => client.status(observedJob, signal),
      accept: value => { observedJob ??= value.latest?.jobId; setStatus(value); setStatusError(undefined); },
      failed: reason => setStatusError(reason instanceof BrowserRequestError && reason.code === "authentication_required"
        ? browserAuthenticationRecovery(client.hasPending()) : "Collection status could not be checked. Previously shown progress may be out of date."),
      hidden: () => document.hidden });
    observer.current = current;
    void current.read();
    const timer = setInterval(() => { void current.read(true); }, 5000);
    const focus = () => { void current.read(true); };
    window.addEventListener("focus", focus);
    return () => { current.stop(); clearInterval(timer); window.removeEventListener("focus", focus); observer.current = undefined; };
  }, [client, statusJob, statusRefresh]);
  useEffect(() => installNewsNavigationGuard(window, document, () => busy || client.hasPending(),
    () => setError("Resolve this refresh request before leaving. Retry the exact request.")), [busy, client]);
  async function run(action: "describe" | "propose" | "approve" | "retry") {
    if (busy || disabled) return;
    setBusy(true); onHold(true); setError(undefined);
    try {
      if (action === "describe") setDescription(await client.describe());
      else if (action === "propose" && description) await client.propose(description, `refresh:${crypto.randomUUID()}`);
      else if (action === "approve") await client.approve();
      else if (action === "retry") await client.retry();
    } catch (reason) {
      setError(reason instanceof BrowserAuthenticationRecoveryError ? reason.message
        : client.hasPending() ? "The request may have completed. Retry the exact request; do not start another refresh."
        : "Could not complete this step. Check your access and reload refresh options. No new request will be sent automatically.");
    } finally { setState(client.state()); setBusy(false); onHold(client.hasPending());
      if (action !== "describe") { observer.current?.stop(); setStatus(undefined); setSelectedJob(undefined); setStatusError(undefined); setStatusRefresh(value => value + 1); } }
  }
  const held = busy || disabled;
  return <section aria-label="Refresh this news source">
    {error ? <p role="alert">{error}</p> : null}
    {client.hasPending() ? <button type="button" disabled={held} onClick={() => void run("retry")}>Retry exact refresh request</button> : <>
      {!state.submitted ? <button type="button" disabled={held} onClick={() => void run("describe")}>Check refresh options</button> : null}
      {description && !description.configured ? <p>Refresh is not connected for this source yet. Saved articles remain available.</p> : null}
      {description?.configured && !state.submitted ? <>
        <p>Read {description.sourceLabel} using {description.mode === "discovery" ? "feed and sitemap discovery" : "its configured feed"}.</p>
        <p>Allowed sites: {description.allowedOrigins.join(", ")}</p>
        <p>Up to {description.limits.maxAttempts} connection attempts in {description.limits.timeoutMs / 1000} seconds.
          Maximum reserved page content: {Math.ceil(description.limits.maxReservedBodyBytes / 1024)} KiB. No agent task or publishing.</p>
        <p>{description.limits.maxArticles ? `Also extract up to ${description.limits.maxArticles} articles within the same connection, time and byte limits.` : "Article extraction is not included in this approval."}</p>
        {!description.canRefresh ? <p>{description.sourceCurrent ? "An authorized owner and active project are required." : "This source changed or was disabled. Its collector configuration needs updating."}</p>
          : !state.proposed ? <button type="button" disabled={held} onClick={() => void run("propose")}>Prepare refresh</button>
            : state.canApprove ? <><p>The job is prepared. Approving allows the collection to run.</p><button type="button" disabled={held} onClick={() => void run("approve")}>Approve and queue refresh</button></>
              : <p>Check refresh options again before approving this prepared job.</p>}
      </> : null}
    </>}
    {state.submitted ? <p role="status">Refresh request recorded. Recorded state: {state.effectState}. This is not a live completion update.</p> : null}
    {state.jobId ? <p style={{ overflowWrap: "anywhere" }}>Job: {state.jobId}</p> : null}
    <button type="button" onClick={() => { void observer.current?.read(); }}>Refresh saved collection status</button>
    {statusError ? <p role="alert">{statusError}</p> : null}
    {status && (!statusJob || status.latest?.jobId === statusJob || status.latest === null) ? <NewsCollectionProgress status={status} /> : <p>Checking saved collection status…</p>}
    <NewsCollectionHistoryBrowser client={client} disabled={held || client.hasPending()} choose={jobId => {
      if (busy || disabled || client.hasPending()) return;
      observer.current?.stop(); setStatus(undefined); setStatusError(undefined); setSelectedJob(jobId); setStatusRefresh(value => value + 1);
    }} />
    <p>Queued and running requests are checked while visible, for up to 180 automatic checks. Refresh status explicitly to check again.</p>
  </section>;
}
