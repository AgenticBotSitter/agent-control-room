"use client";
import { useEffect, useState } from "react";
import { createNewsSourceClient, type NewsSourceInput, type NewsSourcePage } from "../../src/web/v1/news-source-client";
import { installNewsNavigationGuard } from "../../src/web/v1/news-navigation-guard";
import { NewsSourceRefresh } from "./news-source-refresh";
import { BrowserAuthenticationRecoveryError } from "../../src/web/v1/browser-client";

export function NewsSourceSettings({ projectId }: { projectId: string }) {
  const [client] = useState(() => createNewsSourceClient());
  const [page, setPage] = useState<NewsSourcePage>(), [draft, setDraft] = useState<NewsSourceInput>();
  const [after, setAfter] = useState<string>(), [refresh, setRefresh] = useState(0);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string>(), [notice, setNotice] = useState<string>();
  const [refreshHeld, setRefreshHeld] = useState<string>();
  useEffect(() => {
    const abort = new AbortController();
    void client.list(projectId, after, abort.signal).then(value => { if (!abort.signal.aborted) setPage(value); },
      reason => { if (!abort.signal.aborted) setError(reason instanceof BrowserAuthenticationRecoveryError ? reason.message
        : "Could not load source settings. Reload or check your access."); });
    return () => abort.abort();
  }, [client, projectId, after, refresh]);
  useEffect(() => installNewsNavigationGuard(window, document, () => busy || client.hasPending(),
    () => setError("Resolve this save before leaving. Use ‘Retry exact save’.")), [busy, client]);
  const sourceHeld = busy || client.hasPending(), held = sourceHeld || refreshHeld !== undefined;
  function reload(cursor?: string) { setPage(undefined); setError(undefined); setDraft(undefined); setAfter(cursor); setRefresh(value => value + 1); }
  async function save() {
    if (busy || refreshHeld !== undefined || !draft) return;
    setBusy(true); setError(undefined); setNotice(undefined);
    try {
      await (client.hasPending() ? client.retry() : client.save(projectId, draft));
      reload(after); setNotice("Source saved. This does not start collection.");
    } catch (reason) { setError(reason instanceof BrowserAuthenticationRecoveryError ? reason.message
      : client.hasPending() ? "The save may have completed. Retry the exact save before doing anything else."
      : "Could not save. Reload settings before editing again; check your access and public feed URL."); }
    finally { setBusy(false); }
  }
  return <details className="private-panel"><summary>Manage news sources</summary>
    <p>Public source pages and feed URLs only. Do not enter passwords, tokens or private signed links. Saving does not fetch news.</p>
    {notice ? <p role="status">{notice}</p> : null}{error ? <p role="alert">{error}</p> : null}
    <button type="button" disabled={held} onClick={() => reload(after)}>Reload settings</button>
    {!page ? <p>Loading source settings…</p> : !page.configured ? <p>News settings are not configured for this installation.</p> : <>
      {!page.canEdit ? <p>Only an authorized owner can change sources.</p> : <button type="button" disabled={held} onClick={() => setDraft({ source: { id: `source:${crypto.randomUUID()}`, name: "", url: "", enabled: true }, expectedRevision: 0 })}>Add source</button>}
      {page.sources.map(row => <article key={row.source.id}><h3>{row.source.name}</h3><p style={{ overflowWrap: "anywhere" }}>{row.source.url}</p>
        <p>{row.source.enabled ? "Enabled" : "Disabled"} · Revision {row.revision}</p>
        {page.canEdit ? <button type="button" disabled={held} onClick={() => setDraft({ source: { ...row.source }, expectedRevision: row.revision })}>Edit source</button> : null}
        <NewsSourceRefresh projectId={projectId} sourceId={row.source.id} disabled={sourceHeld || refreshHeld !== undefined && refreshHeld !== row.source.id}
          onHold={value => setRefreshHeld(value ? row.source.id : undefined)} /></article>)}
      {!page.sources.length ? <p>No sources saved on this page.</p> : null}
      {after ? <button type="button" disabled={held} onClick={() => reload()}>First sources</button> : null}
      {page.nextCursor ? <button type="button" disabled={held} onClick={() => reload(page.nextCursor!)}>Next sources</button> : null}
    </>}
    {draft ? <form onSubmit={event => { event.preventDefault(); void save(); }}>
      <label>Name<input required maxLength={180} disabled={held} value={draft.source.name} onChange={event => setDraft({ ...draft, source: { ...draft.source, name: event.target.value } })} /></label>
      <label>Public HTTPS page or feed URL<input required type="url" maxLength={2000} disabled={held} value={draft.source.url} onChange={event => setDraft({ ...draft, source: { ...draft.source, url: event.target.value } })} /></label>
      <label><input type="checkbox" disabled={held} checked={draft.source.enabled} onChange={event => setDraft({ ...draft, source: { ...draft.source, enabled: event.target.checked } })} />Enabled</label>
      <button type="submit" disabled={busy || refreshHeld !== undefined}>{client.hasPending() ? "Retry exact save" : "Save source"}</button>
      <button type="button" disabled={held} onClick={() => setDraft(undefined)}>Cancel</button>
    </form> : null}
  </details>;
}
