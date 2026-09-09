"use client";
import { useEffect, useState } from "react";
import { createIdeaDecisionClient } from "../../src/web/v1/idea-decision-client";
import { BrowserRequestError, browserAuthenticationRecovery } from "../../src/web/v1/browser-client";
import type { IdeaDetail, IdeaDecisionReceipt } from "../../src/web/v1/idea-wire";
import { installNewsNavigationGuard } from "../../src/web/v1/news-navigation-guard";

export function IdeaDecisionForm({ detail, pendingChanged }: { detail: IdeaDetail; pendingChanged?: (held: boolean) => void }) {
  const [client] = useState(() => createIdeaDecisionClient());
  const [choice, setChoice] = useState(""), [title, setTitle] = useState(detail.session.title);
  const [summary, setSummary] = useState(detail.synthesis?.nextExperiment ?? "");
  const [busy, setBusy] = useState(false), [error, setError] = useState<string>(), [receipt, setReceipt] = useState<IdeaDecisionReceipt>();
  const held = busy || client.hasPending();
  useEffect(() => { pendingChanged?.(held); return () => pendingChanged?.(false); }, [held, pendingChanged]);
  useEffect(() => installNewsNavigationGuard(window, document, () => busy || client.hasPending(),
    () => setError("This decision may already be saved. Check the same decision again before leaving.")), [busy, client]);
  async function save() {
    if (busy || !detail.synthesis) return; pendingChanged?.(true); setBusy(true); setError(undefined);
    try {
      setReceipt(await (client.hasPending() ? client.retry() : client.decide(detail.session.sessionId, {
        sessionDigest: detail.session.sessionDigest, synthesisDigest: detail.synthesis.synthesisDigest,
        intent: { decision: choice, safeReasonCode: "owner_selected", ...(choice === "create_project" ? { project: {
          projectId: `project:idea:${detail.session.sessionDigest.slice(7)}`, title: title.trim(), workspaceName: title.trim(),
          summary: summary.trim(), projectKind: "business_validation", priority: 50,
        } } : {}) },
      })));
    } catch (reason) { setError(reason instanceof BrowserRequestError && reason.code === "authentication_required"
      ? browserAuthenticationRecovery(client.hasPending())
      : client.hasPending() ? "The decision may have been saved. Check this exact decision again; do not switch choices."
      : "The decision was not saved. Check the fields, access and current discussion before trying again."); }
    finally { pendingChanged?.(client.hasPending()); setBusy(false); }
  }
  if (receipt) return <p role="status">{receipt.decision === "create_project" ? "Project created. No work has started."
    : receipt.decision === "save" ? "Idea saved for later." : "Idea rejected."} {receipt.projectId
      ? <a href={`/projects/${encodeURIComponent(receipt.projectId)}`}>Open project workspace</a> : null}</p>;
  return <form onSubmit={event => { event.preventDefault(); void save(); }}>
    <fieldset disabled={held}><legend>Choose what happens next</legend>
      <label>Your choice<select required value={choice} onChange={event => setChoice(event.target.value)}>
        <option value="" disabled>Select a decision</option>
        {detail.canPromote ? <option value="create_project">Create a project</option> : null}
        <option value="save">Save for later</option><option value="reject">Reject this idea</option>
      </select></label>
      {choice === "create_project" ? <><label>Project title<input required maxLength={120} value={title} onChange={event => setTitle(event.target.value)} /></label>
        <label>Project summary<textarea required maxLength={600} value={summary} onChange={event => setSummary(event.target.value)} /></label></> : null}
    </fieldset>
    <p>This records one final choice for this discussion. Creating a project does not approve or start agent work.</p>
    <button type="submit" disabled={busy}>{client.hasPending() ? "Check this exact decision again" : "Save my decision"}</button>
    {error ? <p role="alert">{error}</p> : null}
  </form>;
}
