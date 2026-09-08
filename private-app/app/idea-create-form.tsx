"use client";
import { useEffect, useState } from "react";
import { createIdeaCreationClient } from "../../src/web/v1/idea-create-client";
import { BrowserRequestError, browserAuthenticationRecovery } from "../../src/web/v1/browser-client";
import type { IdeaCreateDraft, IdeaCreateReceipt } from "../../src/web/v1/idea-wire";
import { installNewsNavigationGuard } from "../../src/web/v1/news-navigation-guard";

export function IdeaCreateForm({ close }: { close: () => void }) {
  const [client] = useState(() => createIdeaCreationClient());
  const [draft, setDraft] = useState<IdeaCreateDraft>({ title: "", ideaSummary: "", targetCustomer: "", maxRounds: 2, maxDurationSeconds: 300, maxCostUsd: 2 });
  const [receipt, setReceipt] = useState<IdeaCreateReceipt>(), [error, setError] = useState<string>(), [busy, setBusy] = useState(false);
  const held = busy || client.hasPending();
  useEffect(() => installNewsNavigationGuard(window, document, () => busy || client.hasPending(),
    () => setError("This save may already have completed. Stay here and check this exact save again before leaving.")), [busy, client]);
  async function save() {
    if (busy) return; setBusy(true); setError(undefined);
    try { setReceipt(await (client.hasPending() ? client.retry() : client.create(draft))); }
    catch (reason) {
      const code = reason instanceof BrowserRequestError ? reason.code : "uncertain";
      setError(code === "authentication_required" ? browserAuthenticationRecovery(client.hasPending())
        : code === "invalid_request" ? "Keep the brief short enough to leave room for bot replies. Check the fields and try a shorter brief."
        : client.hasPending() ? "The save may have completed. Check this exact save again; do not create another copy."
          : "The idea could not be saved. Check your access and configuration.");
    } finally { setBusy(false); }
  }
  return <section className="private-panel" aria-label="New idea"><h2>New idea</h2>
    {receipt ? <p role="status">Idea saved. No bots have started. <a href={`/ideas/${encodeURIComponent(receipt.sessionId)}`}>Open saved idea</a></p>
      : <form onSubmit={event => { event.preventDefault(); void save(); }}>
        <fieldset disabled={held}><legend>Your business idea</legend>
          <label>Title<input required maxLength={120} value={draft.title} onChange={e => setDraft({ ...draft, title: e.target.value })} /></label>
          <label>What is the idea?<textarea required maxLength={800} value={draft.ideaSummary} onChange={e => setDraft({ ...draft, ideaSummary: e.target.value })} /></label>
          <label>Who is it for?<input required maxLength={300} value={draft.targetCustomer} onChange={e => setDraft({ ...draft, targetCustomer: e.target.value })} /></label>
          <label>Maximum rounds<select value={draft.maxRounds} onChange={e => setDraft({ ...draft, maxRounds: Number(e.target.value) })}>{[1, 2, 3].map(n => <option key={n} value={n}>{n}</option>)}</select></label>
          <label>Time limit in seconds<input type="number" min={60} max={900} required value={draft.maxDurationSeconds} onChange={e => setDraft({ ...draft, maxDurationSeconds: Number(e.target.value) })} /></label>
          <label>Cost limit in USD<input type="number" min={0} max={25} step="0.01" required value={draft.maxCostUsd} onChange={e => setDraft({ ...draft, maxCostUsd: Number(e.target.value) })} /></label>
        </fieldset>
        <p>Keep the brief concise. Saving records your idea and limits; it does not contact bots or approve work.</p>
        <button type="submit" disabled={busy}>{client.hasPending() ? "Check this exact save again" : "Save idea"}</button>
      </form>}
    {error ? <p role="alert">{error}</p> : null}<button type="button" disabled={held} onClick={close}>{receipt ? "Back to ideas" : "Cancel"}</button>
  </section>;
}
