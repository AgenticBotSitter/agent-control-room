"use client";
import { useEffect, useState } from "react";
import { createIdeaBrowserClient } from "../../src/web/v1/idea-browser-client";
import type { IdeaDetail, IdeaPage } from "../../src/web/v1/idea-wire";
import { BrowserRequestError, browserErrorMessage } from "../../src/web/v1/browser-client";
import { PrivateHeader } from "./private-header";

export function IdeaDiscussion({ detail }: { detail: IdeaDetail }) {
  const { session, contributions, synthesis, decision } = detail;
  return <><h1>{session.title}</h1><p>{session.ideaSummary}</p><p>For: {session.targetCustomer}</p>
    <p>Saved discussion. Live panel controls are not connected on this installation.</p>
    {contributions.some(c => c.sourceMode === "injected_only") ? <p role="note">This discussion contains synthetic test contributions. Its synthesis is not evidence of a completed live bot panel.</p> : null}
    {Array.from({ length: session.maxRounds }, (_, i) => i + 1).map(round => <section key={round} aria-label={`Round ${round}`}>
      <h2>Round {round}</h2>{session.participants.map(participant => {
        const contribution = contributions.find(c => c.round === round && c.participantId === participant.participantId);
        return <article className="private-panel" key={participant.participantId}><h3>{participant.displayName} · {participant.perspective}</h3>
          {contribution ? <><p style={{ whiteSpace: "pre-wrap" }}>{contribution.safeOpinion}</p>
            <p>{contribution.sourceMode === "injected_only" ? "Synthetic test contribution — no provider was contacted." : "Retained, filtered provider contribution."}</p>
            <p>Suggested experiment: {contribution.suggestedExperiment}</p><p>{contribution.sourceMode === "injected_only" ? "Test confidence" : "Bot-reported confidence"}: {contribution.confidencePercent}%</p></>
            : <p>No contribution saved for this round.</p>}</article>;
      })}</section>)}
    <section className="private-panel"><h2>Synthesis</h2>{synthesis ? <><p>{synthesis.executiveSummary}</p>
      <p>Advisory score: {synthesis.overallScore}/100 — not a prediction of business success.</p>
      <p>Next experiment: {synthesis.nextExperiment}</p></> : <p>No synthesis saved yet.</p>}</section>
    <section className="private-panel"><h2>Your decision</h2>{decision ? <>
      <p>{decision.decision === "create_project" ? "Promoted to a project" : decision.decision === "save" ? "Saved for later" : "Rejected"}</p>
      {decision.project ? <a href={`/projects/${encodeURIComponent(decision.project.projectId)}`}>Open project workspace</a> : null}
    </> : <p>No owner decision saved yet.</p>}</section></>;
}

export function PrivateIdeaWorkspace({ sessionId, after }: { sessionId?: string; after?: string }) {
  const [client] = useState(() => createIdeaBrowserClient());
  const [page, setPage] = useState<IdeaPage>(), [detail, setDetail] = useState<IdeaDetail>();
  const [error, setError] = useState<string>(), [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let active = true; const abort = new AbortController();
    void (async () => {
      try {
        if (sessionId) { const value = await client.detail(sessionId, abort.signal); if (active) setDetail(value); }
        else { const value = await client.list(after, abort.signal); if (active) setPage(value); }
      } catch (reason) {
        if (active) setError(reason instanceof BrowserRequestError ? browserErrorMessage[reason.code] : "Saved ideas are unavailable.");
      }
    })();
    return () => { active = false; abort.abort(); };
  }, [client, sessionId, after, refresh]);
  return <><PrivateHeader /><main className="private-main">
    <nav aria-label="Idea pages"><a href="/ideas">All saved ideas</a></nav>
    <button type="button" onClick={() => { setPage(undefined); setDetail(undefined); setError(undefined); setRefresh(v => v + 1); }}>Refresh saved discussion</button>
    {error ? <p role="alert">{error}</p> : detail ? <IdeaDiscussion detail={detail} /> : page ? <>
      <h1>Idea Lab</h1><p>Explore saved discussions and the projects you chose to pursue.</p>
      {page.availability === "not_configured" ? <p>Idea storage is not configured. No sample discussions are shown.</p>
        : <><p>Creating and running new panels is not connected yet.</p>
          {!page.sessions.length ? <p>No saved ideas on this page.</p> : page.sessions.map(session => <article className="private-panel" key={session.sessionId}>
            <h2><a href={`/ideas/${encodeURIComponent(session.sessionId)}`}>{session.title}</a></h2>
            <p>{session.ideaSummary}</p><p>{session.participantCount} participants · Up to {session.maxRounds} rounds</p>
          </article>)}{page.nextCursor ? <a href={`/ideas?after=${encodeURIComponent(page.nextCursor)}`}>Next saved ideas</a> : null}</>}
    </> : <p role="status">Loading saved ideas…</p>}
  </main></>;
}
