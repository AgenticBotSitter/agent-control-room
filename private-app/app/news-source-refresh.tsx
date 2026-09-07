"use client";
import { useEffect, useState } from "react";
import { createNewsRefreshClient, type NewsRefreshDescription } from "../../src/web/v1/news-refresh-client";
import { installNewsNavigationGuard } from "../../src/web/v1/news-navigation-guard";

export function NewsSourceRefresh({ projectId, sourceId, disabled, onHold }: {
  projectId: string; sourceId: string; disabled: boolean; onHold: (held: boolean) => void;
}) {
  const [client] = useState(() => createNewsRefreshClient(projectId, sourceId));
  const [description, setDescription] = useState<NewsRefreshDescription>();
  const [state, setState] = useState(client.state), [busy, setBusy] = useState(false), [error, setError] = useState<string>();
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
    } catch {
      setError(client.hasPending() ? "The request may have completed. Retry the exact request; do not start another refresh."
        : "Could not complete this step. Check your access and reload refresh options. No new request will be sent automatically.");
    } finally { setState(client.state()); setBusy(false); onHold(client.hasPending()); }
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
        {!description.canRefresh ? <p>{description.sourceCurrent ? "An authorized owner and active project are required." : "This source changed or was disabled. Its collector configuration needs updating."}</p>
          : !state.proposed ? <button type="button" disabled={held} onClick={() => void run("propose")}>Prepare refresh</button>
            : state.canApprove ? <><p>The job is prepared. Approving allows the collection to run.</p><button type="button" disabled={held} onClick={() => void run("approve")}>Approve and queue refresh</button></>
              : <p>Check refresh options again before approving this prepared job.</p>}
      </> : null}
    </>}
    {state.submitted ? <p role="status">Refresh request recorded. Recorded state: {state.effectState}. This is not a live completion update.</p> : null}
    {state.jobId ? <p style={{ overflowWrap: "anywhere" }}>Job: {state.jobId}</p> : null}
  </section>;
}
