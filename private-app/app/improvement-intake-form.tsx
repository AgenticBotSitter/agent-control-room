"use client";

import { useEffect, useRef, useState } from "react";
import { loopDecisionsBrowserClient } from "../../src/web/v1/improve-control-room-loop-decisions-browser-client";
import { refreshSharedTaskAttention } from "./shared-task-attention";

export function ImprovementIntakeForm({ projectId, enabled, onSaved }: { projectId: string; enabled: boolean; onSaved(requestId: string): void }) {
  const [text, setText] = useState(""), [pending, setPending] = useState(false), [notice, setNotice] = useState("");
  const latch = useRef(false), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  return <form className="private-panel private-create" style={{ minWidth: 0, overflowWrap: "anywhere" }} onSubmit={event => {
    event.preventDefault();
    if (latch.current || !enabled || !text.trim() || text.length > 8000 || !navigator.onLine) return;
    latch.current = true; setPending(true); setNotice("");
    const action = Object.freeze({ body: JSON.stringify({ description: text }), key: `loop-intake:${crypto.randomUUID()}` });
    void loopDecisionsBrowserClient.command(projectId, null, "intake", action).then(receipt => {
      if (!mounted.current) return;
      setNotice(receipt.state === "refused" ? "Preparing the request was refused. Your text is retained."
        : receipt.state === "uncertain" ? "Preparation could not be confirmed. Check saved requests before preparing again." : "Draft prepared. Review and confirm the exact saved draft.");
      onSaved(receipt.requestId);
    }).catch(() => mounted.current && setNotice("Preparation could not be confirmed. Your text is retained. Check saved requests before preparing again.")).finally(() => {
      latch.current = false; if (mounted.current) setPending(false); void refreshSharedTaskAttention();
    });
  }}>
    <h2>Prepare an improvement request</h2>
    <label htmlFor="loop-intake-description">What would you like improved?</label>
    <textarea id="loop-intake-description" rows={7} maxLength={8000} required value={text} disabled={pending}
      onChange={event => setText(event.target.value)} />
    <button type="submit" style={{ minHeight: 44 }} disabled={!enabled || pending || !text.trim()}>Prepare request</button>
    <p>This saves a draft for review. Confirm its exact text, then choose Start separately.</p>
    {notice && <p role="status" aria-live="polite">{notice}</p>}
  </form>;
}
