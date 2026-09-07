"use client";
import { useEffect, useState } from "react";
import { createIdeaBrowserClient } from "../../src/web/v1/idea-browser-client";
import type { IdeaDetail, IdeaPage } from "../../src/web/v1/idea-wire";
import { BrowserRequestError, browserErrorMessage } from "../../src/web/v1/browser-client";
import { PrivateHeader } from "./private-header";
import { IdeaCreateForm } from "./idea-create-form";
import { IdeaStopControl } from "./idea-stop-control";
import { IdeaDecisionForm } from "./idea-decision-form";

export function IdeaDiscussion({ detail, refresh, pendingChanged }: { detail: IdeaDetail; refresh?: () => void; pendingChanged?: (held: boolean) => void }) {
  const { session, contributions, synthesis, decision, run } = detail;
  return <><h1>{session.title}</h1><p>{session.ideaSummary}</p><p>For: {session.targetCustomer}</p>
    <p>Saved discussion. Starting live panels is not connected on this installation.</p>
    <section className="private-panel" aria-label="Panel status"><h2>Panel status</h2>{run ? <>
      <p>{({ prepared: "Prepared — no turn started", running: "Discussion in progress", completed: "Discussion completed",
        cancelled: "Discussion stopped", failed_definite: "Discussion failed", ambiguous: "Outcome uncertain — do not restart" })[run.state]}</p>
      <p>{run.messagesUsed} of {run.maxMessages} turns recorded · Reported cost: ${run.costUsd.toFixed(2)}</p>
      <p>{run.providerContacted ? "Provider contact is recorded." : "Provider contact has not been confirmed."}
        {run.state === "running" ? " Saved status does not prove that a bot is still connected." : ""}</p>
      <p>Last recorded update: <time dateTime={run.updatedAt}>{run.updatedAt}</time>. Refresh to check for newer records.</p>
      {run.attempts.some(a => a.state === "provider_marked") ? <p>A turn was started but has no settled result yet.</p> : null}
      <p>Automatic retry is disabled.</p>
      {run.cancellationRequestedAt && run.state !== "cancelled" ? <p>Stop requested. This is not confirmation that the current turn stopped.</p> : null}
      {detail.canStop ? <IdeaStopControl key={run.runId} sessionId={session.sessionId} sessionDigest={session.sessionDigest} runId={run.runId} refresh={refresh} /> : null}
    </> : <p>No panel run is recorded for this idea.</p>}</section>
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
    </> : detail.canDecide ? <IdeaDecisionForm key={session.sessionId} detail={detail} pendingChanged={pendingChanged} />
      : <p>No owner decision saved yet. Decision controls require a saved synthesis, eligible discussion and current owner access.</p>}</section></>;
}

export function PrivateIdeaWorkspace({ sessionId, after }: { sessionId?: string; after?: string }) {
  const [client] = useState(() => createIdeaBrowserClient());
  const [page, setPage] = useState<IdeaPage>(), [detail, setDetail] = useState<IdeaDetail>();
  const [error, setError] = useState<string>(), [refresh, setRefresh] = useState(0);
  const [creating, setCreating] = useState(false);
  const [decisionPending, setDecisionPending] = useState(false);
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
    <button type="button" disabled={creating || decisionPending} onClick={() => { setPage(undefined); setDetail(undefined); setError(undefined); setRefresh(v => v + 1); }}>Refresh saved discussion</button>
    {creating ? <IdeaCreateForm close={() => { setCreating(false); setPage(undefined); setRefresh(v => v + 1); }} /> : null}
    {error ? <p role="alert">{error}</p> : detail ? <IdeaDiscussion detail={detail} refresh={() => setRefresh(v => v + 1)} pendingChanged={setDecisionPending} /> : page ? <>
      <h1>Idea Lab</h1><p>Explore saved discussions and the projects you chose to pursue.</p>
      {page.availability === "not_configured" ? <p>Idea storage is not configured. No sample discussions are shown.</p>
        : <>{page.canCreate ? <button type="button" disabled={creating} onClick={() => setCreating(true)}>New idea</button>
          : <p>Idea creation is not available with the current configuration and access.</p>}<p>Running new panels is not connected yet.</p>
          {!page.sessions.length ? <p>No saved ideas on this page.</p> : page.sessions.map(session => <article className="private-panel" key={session.sessionId}>
            <h2><a href={`/ideas/${encodeURIComponent(session.sessionId)}`}>{session.title}</a></h2>
            <p>{session.ideaSummary}</p><p>{session.participantCount} participants · Up to {session.maxRounds} rounds</p>
          </article>)}{page.nextCursor ? <a href={`/ideas?after=${encodeURIComponent(page.nextCursor)}`}>Next saved ideas</a> : null}</>}
    </> : <p role="status">Loading saved ideas…</p>}
  </main></>;
}
