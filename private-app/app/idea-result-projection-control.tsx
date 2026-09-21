"use client";
import { useState } from "react";
import { createIdeaBrowserClient } from "../../src/web/v1/idea-browser-client";
import { BrowserRequestError, browserErrorMessage } from "../../src/web/v1/browser-client";

/**
 * This control never sends result text or review evidence from the browser.
 * It asks the server to re-check the one saved task result and its owner
 * review before it can add a discussion contribution.
 */
export function IdeaResultProjectionControl({ sessionId, taskKey, refresh }: {
  sessionId: string; taskKey: string; refresh?: () => void;
}) {
  const [pending, setPending] = useState(false), [message, setMessage] = useState<string>();
  return <div><button type="button" disabled={pending} onClick={() => {
    setPending(true); setMessage(undefined);
    void createIdeaBrowserClient().projectReviewedResult(sessionId, taskKey).then(receipt => {
      setMessage(receipt.replayed ? "This reviewed result was already added." : "Reviewed result added to this discussion.");
      refresh?.();
    }).catch((error: unknown) => {
      setMessage(error instanceof BrowserRequestError && error.code === "conflict"
        ? "This task does not yet have one current, reviewed and verified result to add."
        : error instanceof BrowserRequestError ? browserErrorMessage[error.code] : "The saved result could not be checked.");
    }).finally(() => setPending(false));
  }}>{pending ? "Checking reviewed result…" : "Add reviewed result"}</button>
    {message ? <p role="status">{message}</p> : null}</div>;
}
