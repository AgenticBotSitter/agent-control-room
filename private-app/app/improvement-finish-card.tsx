"use client";

import { useEffect, useRef, useState } from "react";
import type { LoopCandidateCardV1 } from "../../src/improve-control-room/v1/loop-candidate-wire";
import { loopCandidateBrowserClientV1 as client, LoopCandidateReadErrorV1,
  type FrozenLoopCandidateDecisionV1 } from "../../src/web/v1/improve-control-room-loop-candidate-browser-client";
import { usePolledRead } from "./use-polled-read";

const identity = (c: LoopCandidateCardV1) => JSON.stringify([c.projectId,c.requestId,c.candidateId,c.recordDigest,c.candidateRevision,c.localVersion,c.a2InputVersion]);
type Read = Awaited<ReturnType<typeof client.read>>;
const targetStyle = { minHeight: 44, minWidth: 44, whiteSpace: "normal" as const, maxWidth: "100%" };

/** Both owner surfaces read the same retained, signed card. Polling has no writer. */
type FinishProps = { projectId?: string; requestId?: string; binding?: string; enabled?: boolean;
  onCurrentCandidateChange?(current: boolean): void };

function humanDuration(durationMs: number) {
  let remaining = durationMs;
  const parts: string[] = [];
  for (const [unit, size] of [["day",86_400_000],["hour",3_600_000],["minute",60_000]] as const) {
    const count = Math.floor(remaining / size);
    if (count) parts.push(`${count} ${unit}${count === 1 ? "" : "s"}`);
    remaining %= size;
  }
  const seconds = remaining / 1000;
  if (seconds || !parts.length) parts.push(`${seconds} second${seconds === 1 ? "" : "s"}`);
  return parts.join(" ");
}
export function ImprovementFinishCard(props: FinishProps) {
  return <FinishRead key={JSON.stringify([props.projectId,props.requestId,props.binding])} {...props} />;
}
function FinishRead({ projectId, requestId, binding = "", enabled = true, onCurrentCandidateChange }: FinishProps) {
  const [epoch,setEpoch] = useState(0), generation = useRef(0), verified = useRef(false);
  const [retained,setRetained] = useState<Read>();
  const key = JSON.stringify(["loop-candidates",projectId,requestId,binding,epoch]);
  const read = usePolledRead({ key,shareKey:key,baseIntervalMs:30_000,enabled,dropValueOnError:true,
    read: async signal => {
      verified.current = false; const captured = generation.current;
      const value = await client.read(signal,projectId,requestId);
      if (signal.aborted || captured !== generation.current) throw new LoopCandidateReadErrorV1(0);
      return value;
    },
    onAccept: value => { verified.current = true; setRetained(value); },
    onFailure: error => { verified.current = false;
      if (error instanceof LoopCandidateReadErrorV1 && error.protectedFailure) { generation.current++; setRetained(undefined); } },
  });
  const value = read.value ?? retained, fresh = enabled && verified.current && !!read.value && !read.error && !read.loading && !read.checking;
  const hasCurrentCandidate = fresh && !!value?.candidates.some(c => c.freshness === "current");
  // Display feedback only: the decision guards continue to use their own verified read.
  useEffect(() => { onCurrentCandidateChange?.(hasCurrentCandidate); }, [hasCurrentCandidate,onCurrentCandidateChange]);
  useEffect(() => () => onCurrentCandidateChange?.(false), [onCurrentCandidateChange]);
  const invalidate = () => { verified.current = false; generation.current++; setEpoch(generation.current); read.clear(); };
  if (!projectId && !value && !read.error) return null;
  if (!projectId && read.error instanceof LoopCandidateReadErrorV1 && read.error.status === 404) return null;
  return <section className="private-panel" aria-label="Loop finished candidates" style={{ minWidth:0,overflowWrap:"anywhere" }}>
    <h2>Finished candidates</h2>
    {!!read.error && <p role="alert">Candidate evidence unavailable. Decisions are blocked.</p>}
    {read.loading && !value && <p role="status">Reading candidate evidence…</p>}
    {!fresh && value && <p role="status">Retained evidence is read only until its current status is verified.</p>}
    {value?.truncated && <p role="status">More saved candidates exist. Open a saved request for its evidence.</p>}
    {value?.candidates.length === 0 && <p>No verified candidate is recorded for this view.</p>}
    {value?.candidates.map(c => <ImprovementFinishCandidate key={identity(c)} card={c} fresh={fresh}
      isFresh={() => verified.current && fresh} invalidate={invalidate} refresh={read.refresh}
      clearProtected={() => { invalidate();setRetained(undefined); }} />)}
    <button type="button" style={targetStyle} onClick={read.refresh}>Refresh candidate</button>
  </section>;
}
export function ImprovementFinishCandidate({ card:c,fresh,isFresh,invalidate,refresh,clearProtected }: { card:LoopCandidateCardV1;fresh:boolean;
  isFresh():boolean;invalidate():void;refresh():void;clearProtected():void }) {
  const e = c.evidence, b = e.binding, latch = useRef(false), frozen = useRef<FrozenLoopCandidateDecisionV1 | undefined>(undefined);
  const mounted = useRef(true), [pending,setPending] = useState(false), [retry,setRetry] = useState(false), [message,setMessage] = useState("");
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; },[]);
  async function decide(decision?:"accept"|"decline") {
    if (latch.current || !isFresh() || !navigator.onLine) return;
    if (decision) {
      if (!c.canDecide || c.freshness !== "current" || c.state !== "ready" || frozen.current) return;
      frozen.current = Object.freeze({ key:`loop-candidate:${crypto.randomUUID()}`,body:JSON.stringify({ candidateId:c.candidateId,
        expectedVersion:1,candidateRecordDigest:c.recordDigest,candidateRevision:c.candidateRevision,localVersion:c.localVersion,
        a2InputVersion:c.a2InputVersion,decision }) });
    }
    const action = frozen.current; if(!action) return;
    latch.current = true; setPending(true);setRetry(false);invalidate();
    try {
      await client.decide(action);
      if(!mounted.current)return;
      frozen.current=undefined;setMessage("Owner decision recorded. No signed deploy or delivery approval was created.");
    } catch(error) {
      if(!mounted.current)return;
      if(error instanceof LoopCandidateReadErrorV1 && error.protectedFailure) { frozen.current=undefined;clearProtected(); }
      else if(error instanceof LoopCandidateReadErrorV1 && error.status>=400 && error.status<500) {
        frozen.current=undefined;setMessage("Decision refused. Refresh the saved candidate.");
      } else { setRetry(true);setMessage("The reply was lost or unavailable. Retry only this exact decision after refreshing."); }
    } finally { latch.current=false;if(mounted.current){setPending(false);refresh();} }
  }
  return <article aria-label="Finished candidate" style={{ minWidth:0,overflowWrap:"anywhere" }}>
    <h3>Finished candidate — {c.state === "ready" ? "waiting for your decision" : c.state === "accepted" ? "Accepted" : "Declined"}</h3>
    <p>{e.summary ?? "Summary: Unavailable"}</p><p>Changed areas: {e.changedAreas?.join(" · ") ?? "Unavailable"}</p>
    <p>Base revision: <code style={{userSelect:"text"}}>{b.baseRevision}</code></p>
    <p>Candidate revision: <code style={{userSelect:"text"}}>{c.candidateRevision}</code></p>
    <p>{!fresh ? "Evidence retained; current status unverified" : c.freshness === "current"
      ? "Evidence checked just now" : "Evidence is out of date; decisions are blocked."}</p>
    <p>Accept and Decline record an owner decision only. Acceptance creates no signed deploy or delivery approval.</p>
    <details><summary style={targetStyle}>Show evidence</summary>
      <p>Database: {e.databaseChanges === null ? "Unavailable" : e.databaseChanges.kind === "none" ? "No database changes declared" :
        `${e.databaseChanges.summary} Compatibility: ${e.databaseChanges.compatibilityNotes} Rollback: ${e.databaseChanges.rollbackNotes}`}</p>
      <h4>Completed checks</h4><ul>{e.checks.map(check => <li key={check.id}>{check.commandLabel}: {check.status} · {check.completed} completed,
        {" "}{check.passed} passed, {check.failed} failed, {check.skipped} skipped · <span title={`${check.durationMs} milliseconds`}>{humanDuration(check.durationMs)}</span> · Exit {check.exitCode ?? "unavailable"}
        <p>Receipt: {check.receiptDigest} · Output: {check.outputDigest}</p></li>)}</ul>
      <h4>Reviews</h4><ul>{e.reviews.map(r => <li key={`${r.stepId}:${r.attempt}`}>
        {r.current ? "Current" : "Historical"} · {r.role} · {r.verdict} · attempt {r.attempt}
        <p>Requested model: {r.requestedModel ?? "Unavailable"}. Observed model: {r.identityVerified ? r.observedModel : "Unverified"}.
          Family: {r.identityVerified ? r.family : "Unverified"}</p><p>{r.candidateRevision} · {r.reportDigest}</p></li>)}</ul>
      <details><summary style={targetStyle}>Findings</summary><ul>{e.findings.map(f => <li key={`${f.origin}:${f.id}`}>
        {f.origin} / {f.id}: {f.severity} · {f.disposition} · {f.summary} · {f.evidenceDigest}</li>)}</ul></details>
      <p>Attempts: {e.rounds.attempts} · Review rejections: {e.rounds.reviewRejections} · Repairs: {e.rounds.repairs ?? "Unavailable"} · Redesigns: {e.rounds.redesigns}</p>
      <p>Elapsed: <span title={`${e.timing.durationMs} milliseconds`}>{humanDuration(e.timing.durationMs)}</span> · {e.timing.startedAt} → {e.timing.finishedAt}</p>
      <details><summary style={targetStyle}>Assumptions and validations</summary>
        {e.assumptions === null ? <p>Assumptions: Unavailable</p>
          : <ul>{e.assumptions.map(a => <li key={a.id}>{a.text} · {a.status} · {a.evidenceDigest ?? "Evidence unavailable"}</li>)}</ul>}
        {e.validations === null ? <p>Validations: Unavailable</p>
          : <ul>{e.validations.map(v => <li key={v.id}>{v.text} · {v.status} · {v.evidenceDigest ?? "Evidence unavailable"}</li>)}</ul>}
      </details>
      <details><summary style={targetStyle}>Recorded overrides</summary>
        <p>Same-family review override: {e.overrides.allowSameFamilyReview ? "Enabled" : "Disabled"}</p>
        <p>Standard final override: {e.overrides.allowStandardFinal ? "Enabled" : "Disabled"}</p>
        <p>Waived conflicts: {e.overrides.waivedConflicts.join(" · ") || "None recorded"}</p><p>Fallback: {e.overrides.fallback ?? "None recorded"}</p>
      </details>
      <p>Completion digest: {e.completionDigest}</p><p>Retention digest: {e.retentionDigest}</p><p>Record digest: {c.recordDigest}</p>
    </details>
    <p><a style={{...targetStyle,display:"inline-block"}} href={`/projects/${encodeURIComponent(c.projectId)}/improvements#request=${encodeURIComponent(c.requestId)}`}>Open saved request</a></p>
    {c.decidedAt && <p>Decision recorded at {c.decidedAt}</p>}
    <div className="private-actions">
      <button type="button" style={targetStyle} disabled={!fresh || !c.canDecide || pending || !!frozen.current} onClick={() => void decide("accept")}>Accept this candidate — record only</button>
      <button type="button" style={targetStyle} disabled={!fresh || !c.canDecide || pending || !!frozen.current} onClick={() => void decide("decline")}>Decline this candidate — record only</button>
    </div>
    {retry && <button type="button" style={targetStyle} disabled={!fresh || pending} onClick={() => void decide()}>Retry this exact decision</button>}
    {message && <p role={retry ? "alert":"status"}>{message}</p>}
  </article>;
}
