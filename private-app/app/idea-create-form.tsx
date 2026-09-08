"use client";
import { useEffect, useState } from "react";
import { createIdeaCreationClient } from "../../src/web/v1/idea-create-client";
import { BrowserRequestError, browserAuthenticationRecovery } from "../../src/web/v1/browser-client";
import type { IdeaCreateDraft, IdeaCreateReceipt, IdeaCreationOptions } from "../../src/web/v1/idea-wire";
import { installNewsNavigationGuard } from "../../src/web/v1/news-navigation-guard";

export function ideaRosterSelectionValid(options: IdeaCreationOptions, selected: string[]) {
  return selected.length >= options.minParticipants && selected.length <= options.maxParticipants
    && new Set(selected).size === selected.length && selected.every(id => options.participants.some(p => p.participantId === id))
    && options.requiredPerspectives.every(perspective => options.participants.some(p => p.perspective === perspective && selected.includes(p.participantId)));
}

export function IdeaRosterSelection({ options, selected, disabled, change }: { options: IdeaCreationOptions;
  selected: string[]; disabled: boolean; change: (selected: string[]) => void }) {
  return <fieldset disabled={disabled}><legend>Choose discussion participants</legend>
    <p>Select {options.minParticipants}–{options.maxParticipants} configured participants. These descriptions do not confirm that a bot is connected or authorized to run.</p>
    <p>The discussion must include a skeptic to challenge assumptions.</p>
    {options.participants.map(participant => <label key={participant.participantId} style={{ display: "block" }}>
      <input type="checkbox" checked={selected.includes(participant.participantId)} onChange={event => change(event.target.checked
        ? [...selected, participant.participantId] : selected.filter(id => id !== participant.participantId))} />
      {participant.displayName} · {participant.perspective} · {participant.harness}
    </label>)}<p>{selected.length} selected</p>
  </fieldset>;
}

export function IdeaCreateForm({ close }: { close: () => void }) {
  const [client] = useState(() => createIdeaCreationClient());
  const [draft, setDraft] = useState<IdeaCreateDraft>({ title: "", ideaSummary: "", targetCustomer: "", maxRounds: 2, maxDurationSeconds: 300, maxCostUsd: 2 });
  const [receipt, setReceipt] = useState<IdeaCreateReceipt>(), [error, setError] = useState<string>(), [busy, setBusy] = useState(false);
  const [options, setOptions] = useState<IdeaCreationOptions>(), [selected, setSelected] = useState<string[]>([]);
  const [optionsLoading, setOptionsLoading] = useState(true), [optionsError, setOptionsError] = useState<string>();
  const [optionsVersion, setOptionsVersion] = useState(0);
  const held = busy || client.hasPending();
  useEffect(() => {
    let active = true; const abort = new AbortController();
    void client.options(abort.signal).then(value => {
      if (active) { setOptions(value); setSelected(value.participants.map(p => p.participantId)); setOptionsError(undefined); }
    }).catch(reason => {
      if (active) setOptionsError(reason instanceof BrowserRequestError && reason.code === "authentication_required"
        ? browserAuthenticationRecovery(client.hasPending()) : "Configured participants could not be loaded. Check access and reload options.");
    }).finally(() => { if (active) setOptionsLoading(false); });
    return () => { active = false; abort.abort(); };
  }, [client, optionsVersion]);
  const rosterValid = !!options && ideaRosterSelectionValid(options, selected);
  useEffect(() => installNewsNavigationGuard(window, document, () => busy || client.hasPending(),
    () => setError("This save may already have completed. Stay here and check this exact save again before leaving.")), [busy, client]);
  async function save() {
    if (busy || !client.hasPending() && (optionsLoading || !rosterValid)) return; setBusy(true); setError(undefined);
    try { setReceipt(await (client.hasPending() ? client.retry() : client.create({ ...draft,
      participantSelections: options!.participants.filter(p => selected.includes(p.participantId))
        .map(({ participantId, participantDigest }) => ({ participantId, participantDigest })),
    }))); }
    catch (reason) {
      const code = reason instanceof BrowserRequestError ? reason.code : "uncertain";
      setError(code === "authentication_required" ? browserAuthenticationRecovery(client.hasPending())
        : client.hasPending() ? "The save may have completed. Check this exact save again; do not create another copy."
          : code === "invalid_request" || code === "conflict" ? "Check the brief and participant selection. The configured roster may have changed: reload options, review your choices and save explicitly."
          : "The idea could not be saved. Check your access and configuration.");
    } finally { setBusy(false); }
  }
  return <section className="private-panel" aria-label="New idea"><h2>New idea</h2>
    {receipt ? <p role="status">Idea saved. No bots have started. <a href={`/ideas/${encodeURIComponent(receipt.sessionId)}`}>Open saved idea</a></p>
      : <form onSubmit={event => { event.preventDefault(); void save(); }}>
        {options ? <IdeaRosterSelection options={options} selected={selected} disabled={held || optionsLoading} change={setSelected} /> : null}
        {optionsLoading ? <p role="status">Loading configured participants…</p> : null}
        {optionsError ? <p role="alert">{optionsError}</p> : null}
        <button type="button" disabled={held || optionsLoading} onClick={() => {
          if (client.hasPending() || busy || optionsLoading) return;
          setOptions(undefined); setOptionsLoading(true); setOptionsError(undefined); setOptionsVersion(value => value + 1);
        }}>Reload participant options</button>
        <fieldset disabled={held}><legend>Your business idea</legend>
          <label>Title<input required maxLength={120} value={draft.title} onChange={e => setDraft({ ...draft, title: e.target.value })} /></label>
          <label>What is the idea?<textarea required maxLength={800} value={draft.ideaSummary} onChange={e => setDraft({ ...draft, ideaSummary: e.target.value })} /></label>
          <label>Who is it for?<input required maxLength={300} value={draft.targetCustomer} onChange={e => setDraft({ ...draft, targetCustomer: e.target.value })} /></label>
          <label>Maximum rounds<select value={draft.maxRounds} onChange={e => setDraft({ ...draft, maxRounds: Number(e.target.value) })}>{[1, 2, 3].map(n => <option key={n} value={n}>{n}</option>)}</select></label>
          <label>Time limit in seconds<input type="number" min={60} max={900} required value={draft.maxDurationSeconds} onChange={e => setDraft({ ...draft, maxDurationSeconds: Number(e.target.value) })} /></label>
          <label>Cost limit in USD<input type="number" min={0} max={25} step="0.01" required value={draft.maxCostUsd} onChange={e => setDraft({ ...draft, maxCostUsd: Number(e.target.value) })} /></label>
        </fieldset>
        <p>Keep the brief concise. Saving records your idea and limits; it does not contact bots or approve work.</p>
        <button type="submit" disabled={busy || !client.hasPending() && (optionsLoading || !rosterValid)}>{client.hasPending() ? "Check this exact save again" : "Save idea"}</button>
      </form>}
    {error ? <p role="alert">{error}</p> : null}<button type="button" disabled={held} onClick={close}>{receipt ? "Back to ideas" : "Cancel"}</button>
  </section>;
}
