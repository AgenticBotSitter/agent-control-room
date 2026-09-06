"use client";
import { useEffect, useState } from "react";
import { PrivateHeader } from "../private-header";
import { readQueueAttention } from "../../../src/web/v1/queue-attention-browser-client";
import type { QueueAttention } from "../../../src/web/v1/queue-attention-wire";
import { BrowserRequestError } from "../../../src/web/v1/browser-client";
import { PrivateTaskAttention } from "./task-attention";

export function QueueAttentionPanel({ snapshot }: { snapshot: QueueAttention }) {
  return <section aria-labelledby="recovery-heading"><h2 id="recovery-heading">Reconnect recovery</h2>
    <p>{snapshot.held} work items held during the last completed checks. Review their task and approval evidence before attempting further work.</p>
    <p>{snapshot.uncertainNodes} recovery checks have an uncertain outcome. Do not assume those jobs never started or send them again.</p>
    <p>{snapshot.truncatedNodes} checks reached the 32-item inspection limit. More work may remain unexamined.</p>
    <p>{snapshot.runningNodes} checks running; {snapshot.notAttemptedNodes} not yet attempted; {snapshot.unavailableNodes} configured connections unavailable.</p>
    <p className="private-note">This is a snapshot of the current server process, not a durable task inbox. Reconnects and server restarts replace these observations.
      Zero counts do not mean all work is finished. Held items are not necessarily failures, and recovered items are not proof of execution.</p>
    <a href="/projects">Open projects and review tasks</a>
  </section>;
}

export function PrivateNeedsMe() {
  const [data, setData] = useState<QueueAttention>();
  const [error, setError] = useState<string>();
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let live = true;
    void readQueueAttention().then(value => { if (live) setData(value); }, failure => {
      if (live) setError(failure instanceof BrowserRequestError && failure.code === "authentication_required"
        ? "Your session has ended. Sign in again."
        : failure instanceof BrowserRequestError && failure.code === "access_denied"
          ? "Owner access is required." : "Recovery status is unavailable or not configured. No all-clear is claimed.");
    }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [refresh]);
  return <div className="private-shell"><PrivateHeader /><main id="private-main">
    <h1>Needs Me</h1><p>Owner-only task attention and recovery observations.</p>
    <PrivateTaskAttention />
    <button type="button" disabled={loading} onClick={() => {
      setLoading(true); setData(undefined); setError(undefined); setRefresh(value => value + 1);
    }}>Check recovery status</button>
    <p>Checking status never starts or retries work.</p>
    {loading && <p role="status">Checking…</p>}{error && <p role="alert">{error}</p>}
    {data && <QueueAttentionPanel snapshot={data} />}
  </main></div>;
}
