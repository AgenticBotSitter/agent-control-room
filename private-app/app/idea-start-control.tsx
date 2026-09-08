"use client";
import { useState } from "react";
import { createIdeaStartClient } from "../../src/web/v1/idea-start-client";
import { BrowserRequestError, browserErrorMessage } from "../../src/web/v1/browser-client";
import type { IdeaDetail, IdeaStartReceipt } from "../../src/web/v1/idea-wire";

export function IdeaStartControl({ session, refresh, observeStart }: { session: IdeaDetail["session"]; refresh?: () => void; observeStart?: () => void }) {
  const [client] = useState(() => createIdeaStartClient()), [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState<IdeaStartReceipt>(), [error, setError] = useState<string>();
  const [uncertain, setUncertain] = useState(false);
  async function start() {
    if (busy || uncertain || receipt) return;
    observeStart?.();
    setBusy(true); setError(undefined);
    try { setReceipt(await client.start(session.sessionId, { sessionDigest: session.sessionDigest })); }
    catch (reason) {
      const unknown = !(reason instanceof BrowserRequestError) || reason.code === "uncertain";
      setUncertain(unknown); setError(!unknown && reason instanceof BrowserRequestError ? browserErrorMessage[reason.code]
        : "The start response could not be confirmed. The discussion may still be running. Refresh saved status; do not create another idea to retry it.");
    } finally { setBusy(false); refresh?.(); }
  }
  return <div>
    <p>{session.participants.length} bots · Up to {session.maxRounds} rounds · {session.maxDurationSeconds} seconds · ${session.maxCostUsd.toFixed(2)} budget</p>
    <p>Start uses the saved roster and limits. Current bot authorization is checked before any turn. No project is created automatically.</p>
    <button type="button" disabled={busy || uncertain || !!receipt} onClick={() => void start()}>{busy ? "Requesting discussion…" : "Start discussion"}</button>
    {error ? <p role="alert">{error}</p> : null}
    {receipt ? <p role="status">{receipt.state === "completed" ? "Discussion completed. Refresh to read its contributions."
      : receipt.state === "running" ? "A discussion run is recorded. Refresh to check progress."
      : receipt.state === "prepared" ? "A start is recorded, but no turn is confirmed. Do not restart it."
      : receipt.state === "ambiguous" ? "The outcome is uncertain. Do not restart this discussion."
      : "The recorded run ended without completing the discussion."}</p> : null}
  </div>;
}
