"use client";
import { useState } from "react";
import { createIdeaStopClient } from "../../src/web/v1/idea-stop-client";
import { BrowserRequestError, browserErrorMessage } from "../../src/web/v1/browser-client";
import type { IdeaStopReceipt } from "../../src/web/v1/idea-wire";

export function IdeaStopControl({ sessionId, sessionDigest, runId, refresh }: {
  sessionId: string; sessionDigest: string; runId: string; refresh?: () => void;
}) {
  const [client] = useState(() => createIdeaStopClient()), [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState<IdeaStopReceipt>(), [error, setError] = useState<string>();
  async function stop() {
    setBusy(true); setError(undefined);
    try { setReceipt(await client.stop(sessionId, { sessionDigest, runId })); refresh?.(); }
    catch (reason) { setError(reason instanceof BrowserRequestError && reason.code !== "uncertain"
      ? browserErrorMessage[reason.code] : "Could not confirm the stop request. Refresh the discussion or try Stop again; it will not start another run."); }
    finally { setBusy(false); }
  }
  return <div><button type="button" disabled={busy || !!receipt} onClick={() => void stop()}>{busy ? "Requesting stop…" : "Stop discussion"}</button>
    <p>Stops future turns. A turn already underway may still return a result.</p>
    {error ? <p role="alert">{error}</p> : null}
    {receipt ? <p role="status">{receipt.state === "cancelled" ? "Discussion stopped." : receipt.cancellationRequestedAt
      ? "Stop request saved. The current turn is not confirmed stopped." : "The discussion already ended; no stop request was needed."}</p> : null}
  </div>;
}
