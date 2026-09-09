"use client";
import { useEffect, useRef, useState } from "react";
import type { createNewsRefreshClient } from "../../src/web/v1/news-refresh-client";
import type { NewsCollectionHistory } from "../../src/web/v1/news-collection-status-wire";
import { BrowserRequestError, browserAuthenticationRecovery } from "../../src/web/v1/browser-client";

export function NewsCollectionHistoryPage({ page, disabled, choose, load }: { page: NewsCollectionHistory; disabled: boolean;
  choose: (jobId: string) => void; load: (after?: string) => void }) {
  return <div aria-label="Saved refresh history"><p>Verified refresh requests in project ID order, not newest-first. Each page checks up to 25 project records for this source.</p>
    {!page.configured ? <p>Collection history is not configured.</p> : !page.entries.length ? <p>No matching refresh requests in this page. More matches may exist on following pages.</p>
      : page.entries.map(entry => <p key={entry.jobId}><button type="button" disabled={disabled} onClick={() => choose(entry.jobId)}>View {entry.jobId}</button>{" "}
        Created <time dateTime={entry.createdAt}>{entry.createdAt}</time></p>)}
    {page.after !== null ? <button type="button" disabled={disabled} onClick={() => load()}>First history page</button> : null}
    {page.nextCursor !== null ? <button type="button" disabled={disabled} onClick={() => load(page.nextCursor!)}>Next history page</button> : null}
  </div>;
}

export function NewsCollectionHistoryBrowser({ client, disabled, choose }: { client: ReturnType<typeof createNewsRefreshClient>;
  disabled: boolean; choose: (jobId: string) => void }) {
  const [page, setPage] = useState<NewsCollectionHistory>(), [busy, setBusy] = useState(false), [error, setError] = useState<string>();
  const operation = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => { operation.current?.abort(); }, []);
  async function load(after?: string) {
    if (disabled || operation.current) return;
    const abort = new AbortController(); operation.current = abort; setBusy(true); setError(undefined);
    try { const value = await client.history(after, abort.signal); if (!abort.signal.aborted) setPage(value); }
    catch (reason) { if (!abort.signal.aborted) setError(reason instanceof BrowserRequestError && reason.code === "authentication_required"
      ? browserAuthenticationRecovery(client.hasPending()) : "Saved refresh history could not be loaded. The previous page has not been replaced."); }
    finally { if (!abort.signal.aborted) { operation.current = undefined; setBusy(false); } }
  }
  return <section aria-label="Browse saved refreshes">
    <button type="button" disabled={disabled || busy} onClick={() => void load()}>Browse saved refreshes</button>
    {busy ? <p role="status">Reading saved refresh history…</p> : null}{error ? <p role="alert">{error}</p> : null}
    {page ? <NewsCollectionHistoryPage page={page} disabled={disabled || busy} choose={choose} load={after => { void load(after); }} /> : null}
  </section>;
}
