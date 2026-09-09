"use client";
import { useState } from "react";
import { createIdeaSynthesisClient } from "../../src/web/v1/idea-synthesis-client";
import { BrowserRequestError, browserErrorMessage } from "../../src/web/v1/browser-client";

export function IdeaSynthesisControl({ sessionId, sessionDigest, runId, refresh }: {
  sessionId: string; sessionDigest: string; runId: string; refresh?: () => void;
}) {
  const [client] = useState(() => createIdeaSynthesisClient()), [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false), [error, setError] = useState<string>();
  async function prepare() {
    setBusy(true); setError(undefined);
    try { await client.synthesize(sessionId, { sessionDigest, runId }); setSaved(true); refresh?.(); }
    catch (reason) { setError(reason instanceof BrowserRequestError && reason.code !== "uncertain"
      ? browserErrorMessage[reason.code] : "Could not confirm the recap was saved. Refresh or try Prepare recap again; neither starts another bot discussion."); }
    finally { setBusy(false); }
  }
  return <div><p>Prepare excerpts from the final turns and a proposed experiment. This uses saved replies, not another AI judgment. No additional bot calls.</p>
    <button type="button" disabled={busy || saved} onClick={() => void prepare()}>{busy ? "Preparing recap…" : "Prepare recap"}</button>
    {error ? <p role="alert">{error}</p> : null}
    {saved ? <p role="status">Recap saved. Refresh to read it and choose your next step.</p> : null}
  </div>;
}
