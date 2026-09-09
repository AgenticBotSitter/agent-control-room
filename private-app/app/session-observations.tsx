"use client";
import { useEffect, useState } from 'react';
import { readBrowserJson } from '../../src/web/v1/browser-json';
import { herdrObservationPageSchema, type HerdrObservationPage } from '../../src/web/v1/herdr-wire';

/** Retained metadata only. Reuses the shared bounded browser JSON reader.
 * No terminal controls, source polling request or worker execution operation.
 */
export function SessionObservations({ projectId }: { projectId: string }) {
  return <BoundSessionObservations key={projectId} projectId={projectId} />;
}
function BoundSessionObservations({ projectId }: { projectId: string }) {
  const [page, setPage] = useState<HerdrObservationPage>();
  const [message, setMessage] = useState('Loading session observations…');
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let stopped = false, busy = false, denied = false, checks = 0;
    let request: AbortController | undefined;
    let freshness: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      if (stopped || busy || denied || document.hidden || checks >= 40) return;
      busy = true; checks++;
      request = new AbortController(); const ownRequest = request;
      const started = performance.now();
      const timeout = setTimeout(() => ownRequest.abort(), 10000);
      clearTimeout(freshness); setPage(undefined); setMessage('Checking access and retained observations…');
      try {
        const response = await fetch(`/api/v1/projects/${encodeURIComponent(projectId)}/observations`, {
          method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: ownRequest.signal,
        });
        if ([401, 403, 404].includes(response.status)) denied = true;
        if (!response.ok) throw new Error();
        const value = herdrObservationPageSchema.parse(await readBrowserJson(response));
        if (value.projectId !== projectId || ownRequest.signal.aborted) throw new Error();
        if (stopped) return;
        // Include the whole request duration, conservatively, so network delay
        // cannot make an old server observation look newly current.
        const age = value.ageMs === null ? null : value.ageMs + Math.max(0, performance.now() - started);
        setPage({ ...value, ageMs: age, status: value.status === 'online' && age! >= 5000 ? 'offline' : value.status });
        setMessage('');
        if (value.status === 'online') freshness = setTimeout(() => {
          if (!stopped) setPage(previous => previous ? { ...previous, status: 'offline' } : previous);
        }, Math.max(0, 5000 - age!));
      } catch {
        if (!stopped) { setPage(undefined); setMessage(denied
          ? 'Session observations are hidden. Check your access before refreshing.'
          : 'Session observations are unavailable. No agent status can be confirmed.'); }
      } finally { clearTimeout(timeout); busy = false; }
    };
    const onFocus = () => { void read(); };
    const onVisibility = () => {
      if (document.hidden) { request?.abort(); clearTimeout(freshness); setPage(undefined); }
      else void read();
    };
    void read();
    const interval = setInterval(() => {
      if (checks >= 40) { setPage(undefined); setMessage('Automatic checks paused. Refresh to continue.'); return; }
      void read();
    }, 15000);
    window.addEventListener('focus', onFocus); document.addEventListener('visibilitychange', onVisibility);
    return () => { stopped = true; request?.abort(); clearTimeout(freshness); clearInterval(interval);
      window.removeEventListener('focus', onFocus); document.removeEventListener('visibilitychange', onVisibility); };
  }, [projectId, refresh]);
  return <section className="private-panel" aria-label="Session observations">
    <h2>Session observations</h2>
    <p>Reported by the optional Herdr observer. These are not verified task results or permission to run work.</p>
    <button type="button" onClick={() => setRefresh(value => value + 1)}>Refresh observations</button>
    {message && <p role="status">{message}</p>}
    {page && <>
      <p role="status">{page.status === 'not_configured' ? 'No session observer is configured for this project.'
        : page.status === 'offline' ? 'Offline or stale — retained observations may no longer describe the agents.'
          : 'Recent observation — not a live connection guarantee.'}</p>
      {page.rows.length > 0 ? <ul>{page.rows.map((row, index) => <li key={row.key}>
        Session {index + 1}: reported {row.status === 'done' ? 'done (completion unverified)' : row.status}
        {row.duplicateSession && ' · Duplicate session reference in this project'}
      </li>)}</ul> : page.status !== 'not_configured' && <p>No retained session observations. This does not prove no agents are running.</p>}
    </>}
  </section>;
}
