"use client";
import { useEffect, useState } from "react";
import { PrivateHeader } from "../private-header";
import { readQueueAttention } from "../../../src/web/v1/queue-attention-browser-client";
import type { QueueAttention } from "../../../src/web/v1/queue-attention-wire";
import { BrowserRequestError } from "../../../src/web/v1/browser-client";
import { PrivateActionInbox } from "./action-inbox";
import { useLocalRuntime } from "../local-runtime";
import { PipelineAttention } from "../project-pipelines-workspace";
import { LoadingState, UnavailableState } from "../owner-ui";

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
  const runtime = useLocalRuntime();
  const [data, setData] = useState<QueueAttention>();
  const [error, setError] = useState<string>();
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    if (runtime.mode === "local") { setLoading(false); setData(undefined); setError(undefined); return; }
    if (runtime.mode !== "hosted") return;
    let live = true;
    void readQueueAttention().then(value => { if (live) setData(value); }, failure => {
      if (live) setError(failure instanceof BrowserRequestError && failure.code === "authentication_required"
        ? "Your session has ended. Sign in again."
        : failure instanceof BrowserRequestError && failure.code === "access_denied"
          ? "Owner access is required." : "Recovery status is unavailable or not configured. No all-clear is claimed.");
    }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [refresh, runtime.mode]);
  return <div className="private-shell"><PrivateHeader /><main id="private-main" tabIndex={-1}>
    {/* The Action Inbox is what this page is FOR, so it leads. Measured in real
        Chromium at 375x812: with the pipeline and recovery sections first, the
        first inbox status sat at 917px -- 105px below the fold -- because two
        section headings and a "check again" button stood between the page title
        and the first item that reports whether anything needs the owner. The
        two lower sections move below the inbox; nothing is removed and the
        reading order is the same for a keyboard, a screen reader and the eye,
        because this is a DOM reorder and not a CSS `order`. */}
    <h1>Action Inbox</h1><p>Owner-only decisions, reviews, blocked work, failures and attention notifications.</p>
    <PrivateActionInbox />
    <PipelineAttention />
    {runtime.mode !== "local" ? <><button type="button" disabled={loading} onClick={() => {
      setLoading(true); setData(undefined); setError(undefined); setRefresh(value => value + 1);
    }}>Check recovery status</button>
    <p>Checking status never starts or retries work.</p>
    {loading && <LoadingState>Checking…</LoadingState>}
    {/* The failure sentence is rendered in the unavailable treatment rather than a
        bare alert paragraph, so "could not check" looks different from "checking"
        and from an empty list. It keeps role="alert" because a read that failed is
        the one thing here that must interrupt. */}
    {error && <UnavailableState urgent>{error}</UnavailableState>}
    {data && <QueueAttentionPanel snapshot={data} />}</> : <section aria-labelledby="local-recovery-heading">
      <h2 id="local-recovery-heading">Task recovery</h2>
      <p>Open the exact task to check its saved delivery and result evidence. This page does not start, retry or replace work.</p>
    </section>}
  </main></div>;
}
