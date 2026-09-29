"use client";

import { useCallback, useState } from "react";
import { readSessionWatchV1 } from "../../../src/web/v1/session-watch-browser-client";
import type { SessionWatchPageV1 } from "../../../src/web/v1/session-watch-wire";
import { ConfiguredTimestamp } from "../configured-timestamp";
import { PrivateHeader } from "../private-header";
import { useVisiblePolling } from "../use-visible-polling";

type ReadState = { state: "loading" } | { state: "ready"; value: SessionWatchPageV1 } | { state: "unavailable" };
const taskHref = (projectId: string, jobId: string) =>
  `/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(jobId)}`;

export function formatSessionDurationV1(seconds: number) {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  const hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds % 3600 / 60);
  return `${hours}h ${minutes}m`;
}

export function SessionWatchView({ page, after }: { page: SessionWatchPageV1; after?: string }) {
  if (page.source === "not_configured") return <section className="private-panel"><p role="status">Session evidence is unavailable because signed run history is not configured. No running or all-clear state is inferred.</p></section>;
  return <>
    {!page.sessions.length ? <section className="private-panel"><p>No current saved agent sessions were found. This does not prove that no agent process is running.</p></section>
      : <ul className="private-session-watch-list">{page.sessions.map(session => <li key={session.sessionId}>
        <div className="private-session-watch-heading"><span className={`private-state private-session-${session.state}`}>{session.state.replaceAll("_", " ")}</span>
          <h2><a href={taskHref(session.projectId, session.jobId)}>{session.taskTitle}</a></h2></div>
        <dl className="private-task-facts">
          <div><dt>Worker</dt><dd>{session.worker ?? "Unavailable"}</dd></div>
          <div><dt>Harness and model</dt><dd>{session.harness ?? "Harness unavailable"} · {session.model ?? "Model unavailable"}{session.effort ? ` · ${session.effort}` : ""}</dd></div>
          <div><dt>Attempt and stage</dt><dd>Attempt {session.attemptNumber} · {session.stage}</dd></div>
          <div><dt>Run time</dt><dd>{formatSessionDurationV1(session.durationSeconds)}</dd></div>
          <div><dt>Last heartbeat or progress</dt><dd>{session.lastProgress} · <ConfiguredTimestamp value={session.lastProgressAt} /></dd></div>
        </dl>
      </li>)}</ul>}
    <nav className="private-actions" aria-label="Session pages">
      {after ? <a href="/session-watch">First page</a> : null}
      {page.nextCursor ? <a href={`/session-watch?after=${encodeURIComponent(page.nextCursor)}`}>Next sessions</a> : null}
    </nav>
  </>;
}

export function SessionWatchWorkspace({ after }: { after?: string }) {
  const [data, setData] = useState<ReadState>({ state: "loading" });
  const load = useCallback(async (signal: AbortSignal) => {
    try { setData({ state: "ready", value: await readSessionWatchV1(after, fetch, signal) }); }
    catch { if (!signal.aborted) setData({ state: "unavailable" }); }
  }, [after]);
  const refresh = useVisiblePolling(load);
  return <div className="private-shell"><PrivateHeader /><main id="private-main" tabIndex={-1}>
    <div className="private-heading"><p className="private-eyebrow">Across projects</p><h1>Session watch</h1>
      <p>Authenticated saved run evidence for agent sessions in this workspace. Stalled means the last observation is past this view's 120-second freshness window; unavailable fields are not inferred.</p>
      <p className="private-note">This page is read-only. Refreshing does not start, stop, retry, resume, approve or accept work.</p>
      <button type="button" onClick={refresh}>Check saved sessions again</button></div>
    {data.state === "loading" ? <p role="status">Loading saved session evidence…</p>
      : data.state === "unavailable" ? <section className="private-panel"><p role="status">Session evidence is unavailable. No running or all-clear state is inferred.</p></section>
        : <SessionWatchView page={data.value} after={after} />}
  </main></div>;
}
