"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { StateChip, type ChipTone } from "./owner-ui";
import { createOperationsModeBrowserClient } from "../../src/web/v1/operations-mode-browser-client";
import { BrowserRequestError, browserErrorMessage } from "../../src/web/v1/browser-client";
import type { OperationsModeV1, OperationsModeReceiptV1, OperationsModeViewV1 } from "../../src/web/v1/operations-mode-wire";

export const OPERATIONS_CONTROL_STATES = ["running", "paused", "draining", "stopped"] as const;
export type { OperationsModeV1 };

const labels: Record<OperationsModeV1, { label: string; tone: ChipTone; explanation: string }> = {
  running: { label: "Running", tone: "good", explanation: "Work proceeds as normal." },
  paused: { label: "Paused", tone: "warn",
    explanation: "No new work is claimed or started. Work already in progress keeps running." },
  draining: { label: "Draining", tone: "warn",
    explanation: "No new work is claimed or started. Work already in progress finishes rather than being extended." },
  stopped: { label: "Stopped", tone: "bad",
    explanation: "Nothing new is claimed or started, and running work has been asked to stop." },
};
const AUTO_PAUSE_REASON = "Paused automatically — this Mac was too busy. It will start again by itself when things calm down.";

/**
 * The mode is a server-side fact, not a browser note.
 *
 * It is read from the authenticated endpoint on mount, so the phone, the
 * desktop and the workers all see the same state, and a page loaded on a
 * different device shows what the installation is actually doing. Nothing is
 * cached in this browser: the previous localStorage version survived a reload on
 * one browser and nothing else, and said so in a permanent disclosure.
 *
 * A failed read is not a mode. The panel then says the state is unknown and
 * offers the one action that is still trustworthy — read it again — rather than
 * showing a green "Running" it did not read.
 */
/** The only two things the panel asks the server. Typed structurally so a test
 * can supply a stand-in, and so nothing else can be smuggled in. */
export type OperationsModeClient = {
  read: (signal?: AbortSignal) => Promise<OperationsModeViewV1>;
  set: (value: unknown, signal?: AbortSignal) => Promise<OperationsModeReceiptV1>;
};

export function useOperationsControl(client: OperationsModeClient = createOperationsModeBrowserClient()) {
  const [view, setView] = useState<OperationsModeViewV1>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  const read = useCallback(async () => {
    try {
      const next = await client.read();
      if (!mounted.current) return;
      setView(next); setError(undefined);
    } catch (reason) {
      if (!mounted.current) return;
      setView(undefined);
      setError(reason instanceof BrowserRequestError ? browserErrorMessage[reason.code]
        : "Control Room could not read the current state. No change was made.");
    }
  }, [client]);
  useEffect(() => {
    mounted.current = true;
    void read();
    return () => { mounted.current = false; };
  }, [read]);
  const set = useCallback(async (mode: OperationsModeV1, reason: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await client.set({ mode, reason });
      await read();
    } catch (reason) {
      if (mounted.current) setError(reason instanceof BrowserRequestError ? browserErrorMessage[reason.code]
        : "Control Room could not change the state. Check the current state before trying again.");
    } finally { if (mounted.current) setBusy(false); }
  }, [busy, client, read]);
  return { view, error, busy, set, refresh: read };
}

export function OperationsControlPanel({ client }: { client?: OperationsModeClient } = {}) {
  const { view, error, busy, set, refresh } = useOperationsControl(client);
  const [reason, setReason] = useState("");
  return <form className="private-panel" aria-labelledby="operations-control-title"
    onSubmit={event => event.preventDefault()}>
    <h2 id="operations-control-title">Pause, drain or stop</h2>
    {view
      ? <>
        <p><StateChip state={view.mode} tone={labels[view.mode].tone} label={labels[view.mode].label} />{" "}
          {labels[view.mode].explanation}</p>
        {view.mode === "paused" && view.reason === AUTO_PAUSE_REASON
          && <p className="private-notice">Paused automatically — this Mac was too busy. It will start again by itself when things calm down.</p>}
        {view.revision > 0
          ? <p className="private-note">Set {new Date(view.setAt).toLocaleString()}{view.reason ? ` — ${view.reason}` : ""}.</p>
          : <p className="private-note">No one has paused this installation, so it is running normally.</p>}
        {!view.admitsNewWork
          && <p className="private-note">No new work will be claimed or started while this is set.</p>}
        {view.mode === "stopped" && view.stopRequests
          && <p className="private-note">Control Room asked {view.stopRequests.requested === null
            ? "the running work" : view.stopRequests.requested} to stop; {view.stopRequests.revoked} were stopped here.
            It cannot confirm that a process on a worker saw the request
            {view.stopRequests.uncertainJobIds.length
              ? `, and ${view.stopRequests.uncertainJobIds.length} could not be stopped` : ""}.</p>}
      </>
      : <p role="status">{error ?? "Reading the current state…"}</p>}
    {error && view && <p role="alert" className="private-notice">{error}</p>}
    <label htmlFor="operations-control-reason">Reason (optional, shown with the state above)</label>
    <textarea id="operations-control-reason" rows={2} maxLength={240} value={reason} disabled={busy}
      onChange={event => setReason(event.target.value)} />
    <div className="private-actions">
      {/* With no state read there is nothing to change *from*, so a press would
          be a blind write against an installation whose current state is
          unknown. Read again is the only action offered until a read succeeds. */}
      {view && OPERATIONS_CONTROL_STATES.filter(state => state !== view.mode).map(state =>
        <button key={state} type="button" disabled={busy}
          onClick={event => {
            // Read the field from the form the button belongs to, not from a
            // state value the render may have closed over before the last
            // keystroke. A reason the owner typed and then immediately pressed a
            // mode for is the reason they meant to record.
            const form = event.currentTarget.form;
            void set(state, form ? (form.elements.namedItem("operations-control-reason") as HTMLTextAreaElement | null)?.value ?? "" : reason);
            setReason("");
          }}>{labels[state].label}</button>)}
      <button type="button" disabled={busy} onClick={() => { void refresh(); }}>Read again</button>
    </div>
  </form>;
}
