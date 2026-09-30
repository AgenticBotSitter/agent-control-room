"use client";

import { useEffect, useRef, useState } from "react";
import { updateCandidateDecisionReceiptSchemaV1, updateCandidatePageSchemaV1,
  type UpdateCandidateViewV1 } from "../../src/improve-control-room/v1/schemas";
import { readBrowserJson } from "../../src/web/v1/browser-json";
import { ConfiguredTimestamp } from "./configured-timestamp";
import { PanelHeading, StateChip } from "./owner-ui";

export type UpdateCandidatesStateV1 = { state: "loading" } | { state: "not_configured" }
  | { state: "ready"; candidates: UpdateCandidateViewV1[] } | { state: "unavailable" };
type State = UpdateCandidatesStateV1;
type Message = "saved" | "failed" | "uncertain";
class NotConfigured extends Error {}

export function UpdateCandidatesHome() {
  const [state, setState] = useState<State>({ state: "loading" }), [pending, setPending] = useState<string>();
  const [message, setMessage] = useState<Message>(), [generation, setGeneration] = useState(0);
  const retained = useRef<{ candidate: UpdateCandidateViewV1; decision: "accept" | "decline"; key: string } | undefined>(undefined);
  useEffect(() => {
    const abort = new AbortController(); setState({ state: "loading" });
    void fetch("/api/v1/update-candidates", { credentials: "same-origin", cache: "no-store", redirect: "error",
      signal: abort.signal, headers: { accept: "application/json", "x-requested-with": "XMLHttpRequest" } })
      .then(async response => {
        // No desk on this installation (no pipeline key): nothing to decide, and no alarm.
        if (response.status === 404) throw new NotConfigured();
        if (!response.ok) throw new Error(); return updateCandidatePageSchemaV1.parse(await readBrowserJson(response)); })
      .then(value => { if (!abort.signal.aborted) setState({ state: "ready", candidates: value.candidates }); },
        error => { if (!abort.signal.aborted) setState({ state: error instanceof NotConfigured ? "not_configured" : "unavailable" }); });
    return () => abort.abort();
  }, [generation]);
  async function decide(candidate?: UpdateCandidateViewV1, decision?: "accept" | "decline") {
    if (pending) return;
    if (candidate && decision) retained.current = { candidate, decision, key: `update-decision:${crypto.randomUUID()}` };
    const exact = retained.current; if (!exact) return;
    setPending(exact.candidate.candidateId); setMessage(undefined);
    try {
      const response = await fetch(`/api/v1/update-candidates/${encodeURIComponent(exact.candidate.candidateId)}/decision`, {
        method: "POST", credentials: "same-origin", cache: "no-store", redirect: "error", headers: { accept: "application/json",
          "content-type": "application/json", "x-requested-with": "XMLHttpRequest", "idempotency-key": exact.key },
        body: JSON.stringify({ candidateId: exact.candidate.candidateId, expectedVersion: exact.candidate.version,
          candidateRecordDigest: exact.candidate.recordDigest, decision: exact.decision }),
      });
      if (!response.ok) { if (response.status >= 500) throw new TypeError(); retained.current = undefined; throw new Error(); }
      const receipt = updateCandidateDecisionReceiptSchemaV1.parse(await readBrowserJson(response));
      if (receipt.startsDeploy || receipt.signedDeployApprovalCreated || receipt.grantsDeployAuthority) throw new Error();
      retained.current = undefined; setMessage("saved"); setGeneration(value => value + 1);
    } catch (error) { setMessage(error instanceof TypeError ? "uncertain" : "failed"); }
    finally { setPending(undefined); }
  }
  return <UpdateCandidatesPanel state={state} pending={pending} message={message}
    onDecide={(candidate, decision) => { void decide(candidate, decision); }} onRetry={() => { void decide(); }} />;
}

/** Attention first: the panel exists only while a signed-off update waits for the
 * owner, a decision needs its outcome shown, or the read genuinely failed. */
export function UpdateCandidatesPanel({ state, pending, message, onDecide, onRetry }: { state: State; pending?: string;
  message?: Message; onDecide: (candidate: UpdateCandidateViewV1, decision: "accept" | "decline") => void; onRetry: () => void }) {
  const waiting = state.state === "ready" && state.candidates.length > 0;
  if (!waiting && state.state !== "unavailable" && !message) return null;
  return <section className="private-panel private-update-ready" aria-labelledby="home-update-ready">
    <PanelHeading id="home-update-ready">Update ready</PanelHeading>
    {state.state === "unavailable" ? <p role="alert">Update candidates are unavailable. No empty or all-clear state is inferred.</p>
      : !waiting ? <p>No signed-off update is waiting for your decision.</p>
        : <ul className="private-dashboard-list">{(state.state === "ready" ? state.candidates : []).map(candidate => <li key={candidate.candidateId}>
            <StateChip state="ready" tone="warn" /><strong>{candidate.summary}</strong>
            <span>{candidate.changedAreas.join(" · ")}</span>
            <span>Revision: {candidate.baseRevision.slice(0, 12)} → {candidate.candidateRevision.slice(0, 12)}</span>
            <span>Tests: {candidate.testResults.map(result => `${result.profile} ${result.status.replaceAll("_", " ")} · ${result.runner.kind.replaceAll("_", " ")}${result.testCount === null ? "" : ` · ${result.testCount} tests`}`).join(" | ")}</span>
            <span>Database: {candidate.databaseChanges.kind === "none" ? "No database changes declared"
              : `${candidate.databaseChanges.migrationIds.join(", ")} · ${candidate.databaseChanges.summary}`}</span>
            <span>Risk review: {candidate.riskFlags.length === 0 ? "No independent-review flag"
              : `${candidate.riskFlags.map(flag => flag.kind).join(", ")} · independent review verified`}</span>
            <ConfiguredTimestamp value={candidate.createdAt} prefix="Signed off" />
            <div className="private-actions"><button type="button" disabled={!!pending}
              onClick={() => onDecide(candidate, "accept")}>Accept</button>
              <button type="button" disabled={!!pending} onClick={() => onDecide(candidate, "decline")}>Decline</button></div>
            <a href={`/projects/${encodeURIComponent(candidate.projectId)}/improvements`}>Open improvement desk</a>
          </li>)}</ul>}
    <p className="private-note"><strong>Deploy and restart are not active.</strong> Accept records this owner decision only; it creates no signed deploy approval.</p>
    {message === "saved" && <p role="status">Owner decision recorded. No deployment started.</p>}
    {message === "failed" && <p role="alert">The decision was not saved. Check the current candidate before deciding again.</p>}
    {message === "uncertain" && <div className="private-notice"><p role="alert">The decision may have saved. Do not choose again.</p>
      <button type="button" disabled={!!pending} onClick={onRetry}>Retry this exact decision</button></div>}
  </section>;
}
