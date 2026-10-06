"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { StateChip, type ChipTone } from "./owner-ui";
import { ownerStatusLabels } from "./owner-status-labels";
import { ConfiguredTimestamp } from "./configured-timestamp";
import { createOperationsModeBrowserClient } from "../../src/web/v1/operations-mode-browser-client";
import { BrowserRequestError, browserErrorMessage } from "../../src/web/v1/browser-client";
import type { OperationsModeV1, OperationsModeReceiptV1, OperationsModeViewV1 } from "../../src/web/v1/operations-mode-wire";

export const OPERATIONS_CONTROL_STATES = ["running", "paused", "draining", "stopped"] as const;
export type { OperationsModeV1 };

const labels: Record<OperationsModeV1, { label: string; tone: ChipTone; explanation: string }> = {
  running: { label: ownerStatusLabels.operations.running, tone: "good", explanation: "Work proceeds as normal." },
  paused: { label: ownerStatusLabels.operations.paused, tone: "warn",
    explanation: "No new work is claimed or started. Work already in progress keeps running." },
  draining: { label: ownerStatusLabels.operations.draining, tone: "warn",
    explanation: "No new work is claimed or started. Work already in progress finishes rather than being extended." },
  stopped: { label: ownerStatusLabels.operations.stopped, tone: "bad",
    explanation: "Nothing new is claimed or started, and running work has been asked to stop." },
};
const AUTO_PAUSE_REASON = "Paused automatically — this Mac was too busy. It will start again by itself when things calm down.";

/**
 * The mode is a server-side fact, not a browser note.
 *
 * It is read from the authenticated endpoint on mount and visible return, so the phone, the
 * desktop and the workers all see the same state, and a page loaded on a
 * different device shows what the installation is actually doing. Nothing is
 * cached in this browser: the previous localStorage version survived a reload on
 * one browser and nothing else, and said so in a permanent disclosure.
 *
 * The last successful answer stays visible while checking again, including
 * after a failed refresh. It is labelled as last known until a new answer
 * arrives. With no successful read, only Read again is offered.
 */
/** The only two things the panel asks the server. Typed structurally so a test
 * can supply a stand-in, and so nothing else can be smuggled in. */
export type OperationsModeClient = {
  read: (signal?: AbortSignal) => Promise<OperationsModeViewV1>;
  set: (value: unknown, signal?: AbortSignal) => Promise<OperationsModeReceiptV1>;
};

export function useOperationsControl(supplied?: OperationsModeClient) {
  // ONE client per mount. A default parameter built a new client on every
  // render, so `read` changed identity every render, the mount effect re-ran,
  // and each successful read rendered and read again: an endless stream of
  // GETs on Home, where no client is passed. The tests always passed a stable
  // stub, which is why it never showed there.
  const [fallback] = useState(createOperationsModeBrowserClient);
  const client = supplied ?? fallback;
  const [view, setView] = useState<OperationsModeViewV1>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(true);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const mounted = useRef(true);
  const pendingRead = useRef<{ controller: AbortController; promise: Promise<void> } | undefined>(undefined);
  const pendingWrite = useRef<AbortController | undefined>(undefined);
  const cancelRead = useCallback(() => {
    pendingRead.current?.controller.abort();
    pendingRead.current = undefined;
  }, []);
  const read = useCallback(() => {
    if (!mounted.current) return Promise.resolve();
    if (pendingRead.current) return pendingRead.current.promise;
    const request = { controller: new AbortController(), promise: Promise.resolve() };
    pendingRead.current = request;
    setChecking(true); setRefreshFailed(false); setError(undefined);
    request.promise = (async () => {
      try {
        const next = await client.read(request.controller.signal);
        if (!mounted.current || pendingRead.current !== request) return;
        setView(next); setError(undefined);
      } catch (reason) {
        if (!mounted.current || pendingRead.current !== request) return;
        setRefreshFailed(true);
        setError(reason instanceof BrowserRequestError && ["authentication_required", "access_denied"].includes(reason.code)
          ? browserErrorMessage[reason.code]
          : "The current work mode could not be checked. Use Read again. No change was requested.");
      } finally {
        if (mounted.current && pendingRead.current === request) {
          pendingRead.current = undefined; setChecking(false);
        }
      }
    })();
    return request.promise;
  }, [client]);
  useEffect(() => {
    mounted.current = true;
    const visibleRead = () => {
      if (!document.hidden && !pendingWrite.current) void read();
    };
    const visibility = () => {
      if (document.hidden) {
        cancelRead(); setChecking(true);
      } else visibleRead();
    };
    visibleRead();
    const poll = setInterval(visibleRead, 30_000);
    window.addEventListener("focus", visibleRead);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      mounted.current = false; clearInterval(poll); cancelRead(); pendingWrite.current?.abort();
      window.removeEventListener("focus", visibleRead);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [cancelRead, read]);
  const set = useCallback(async (mode: OperationsModeV1, reason: string) => {
    // pendingWrite is the one synchronous latch (D20): a duplicate, an unmounted
    // form or an offline device answers false, and nothing is sent.
    if (!mounted.current || pendingWrite.current) return false;
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      setError("You are offline. The change was not sent. Your reason draft is kept; reconnect and try again."); return false;
    }
    const request = new AbortController();
    pendingWrite.current = request;
    cancelRead();
    setBusy(true);
    try {
      await client.set({ mode, reason }, request.signal);
      await read();
      return true;
    } catch (reason) {
      if (mounted.current) {
        setChecking(false);
        setError(reason instanceof BrowserRequestError ? browserErrorMessage[reason.code]
          : "Control Room could not change the state: the state change could not be confirmed, and it may have completed. Check the current state before trying again.");
      }
      return false;
    } finally {
      pendingWrite.current = undefined;
      if (mounted.current) setBusy(false);
    }
  }, [cancelRead, client, read]);
  return { view, error, busy, checking, refreshFailed, set, refresh: read };
}

export type OperationsControl = ReturnType<typeof useOperationsControl>;

export function OperationsControlPanel({ client, control }: { client?: OperationsModeClient; control?: OperationsControl } = {}) {
  return control ? <OperationsControlForm control={control} /> : <StandaloneOperationsControl client={client} />;
}

function StandaloneOperationsControl({ client }: { client?: OperationsModeClient }) {
  const control = useOperationsControl(client);
  return <OperationsControlForm control={control} />;
}

function OperationsControlForm({ control }: { control: OperationsControl }) {
  const { view, error, busy, checking, refreshFailed, set, refresh } = control;
  const [reason, setReason] = useState("");
  const activated = useRef<HTMLButtonElement | null>(null);
  const readAgain = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    if (busy || !activated.current) return;
    const button = activated.current;
    activated.current = null;
    if (!button.isConnected && document.activeElement === document.body) readAgain.current?.focus();
  }, [busy, view]);
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
          ? <p className="private-note">Set <ConfiguredTimestamp value={view.setAt} />{view.reason ? ` — ${view.reason}` : ""}.</p>
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
      : <p role="status">{checking ? "Checking… Reading the current state…" : error}</p>}
    {view && checking && <p role="status" className="private-note">Checking…</p>}
    {view && refreshFailed && <p role="status" className="private-note">{ownerStatusLabels.attention.refreshFailed}</p>}
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
            activated.current = document.activeElement === event.currentTarget ? event.currentTarget : null;
            // Read the field from the form the button belongs to, not from a
            // state value the render may have closed over before the last
            // keystroke. A reason the owner typed and then immediately pressed a
            // mode for is the reason they meant to record.
            const form = event.currentTarget.form;
            void set(state, form ? (form.elements.namedItem("operations-control-reason") as HTMLTextAreaElement | null)?.value ?? "" : reason)
              .then(saved => { if (saved) setReason(""); });
          }}>{labels[state].label}</button>)}
      <button ref={readAgain} type="button" disabled={busy} onClick={() => { void refresh(); }}>Read again</button>
    </div>
    {error && <p role="status">Your reason draft is kept. Read the saved state before retrying an unconfirmed change.</p>}
  </form>;
}
