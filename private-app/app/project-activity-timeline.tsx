"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { ProjectEventV1 } from "../../src/project-events/v1/types";
import { BrowserRequestError } from "../../src/web/v1/browser-request-error";
import { mergeProjectActivityEventsV1, parseLiveProjectEventV1, parseProjectActivityStreamHeadV1,
  readProjectActivityPageV1 } from "../../src/web/v1/project-activity-browser-client";
import { ConfiguredTimestamp } from "./configured-timestamp";
import { PrivateHeader } from "./private-header";
import { ProjectNavigation } from "./project-navigation";

type LiveState = "connecting" | "live" | "caught_up" | "reconnecting" | "retrying";
export type ProjectActivityTimelineStateV1 = { state: "loading" }
  | { state: "unavailable"; code: BrowserRequestError["code"] }
  | { state: "ready"; events: readonly ProjectEventV1[]; olderCursor: string | null; loadingOlder: boolean;
      live: LiveState; retryInSeconds: number };

function label(value: string) { return value.replaceAll("_", " ").replace(/\b\w/g, letter => letter.toUpperCase()); }

export function ProjectActivityTimelineViewV1({ state, projectId, onOlder }: {
  state: ProjectActivityTimelineStateV1; projectId: string; onOlder?: () => void;
}) {
  if (state.state === "loading") return <section className="private-panel"><h2>Activity timeline</h2>
    <p role="status">Loading saved project activity…</p></section>;
  if (state.state === "unavailable") return <section className="private-panel"><h2>Activity timeline</h2>
    <p role="alert">{state.code === "access_denied" ? "Only an owner with access to this project can read its activity."
      : state.code === "authentication_required" ? "Your session has ended. Sign in again to see this project’s activity."
        : "The protected activity source is unavailable. No empty timeline or all-clear is inferred, and checking again never starts work."}</p>
    {state.code === "authentication_required" && <><p>Signing in again through Access logout also ends Access sessions for other protected applications.</p>
      <a href="/cdn-cgi/access/logout">Sign in again</a></>}
    </section>;
  return <section className="private-panel"><div className="private-heading"><div><p className="private-eyebrow">Append-only project record</p>
    <h2>Activity timeline</h2></div><span className="private-state" aria-live="polite">{label(state.live)}</span></div>
    <p className="private-note">Read-only history. Loading, reconnecting, and checking older events never approves, dispatches, retries, or changes work.</p>
    {state.live === "retrying" && <p role="status">The saved activity stream stopped responding. Retrying in
      {state.retryInSeconds} second{state.retryInSeconds === 1 ? "" : "s"}. The events already shown are unchanged.</p>}
    {state.events.length ? <ol className="private-dashboard-list">{[...state.events].reverse().map(event => <li key={event.eventDigest}>
      <strong>{event.safeSummary}</strong><span>{label(event.eventKind)} · <ConfiguredTimestamp value={event.occurredAt} prefix="Occurred" /></span>
      {event.safeDetail && <p>{event.safeDetail}</p>}{event.deepLinkPath && <a href={event.deepLinkPath}>Open related record</a>}
    </li>)}</ol> : <p>No saved project events are recorded yet.</p>}
    {state.olderCursor && <button type="button" disabled={state.loadingOlder} onClick={onOlder}>
      {state.loadingOlder ? "Loading older activity…" : "Load older activity"}</button>}
    <span className="private-note">Project {projectId}</span>
    </section>;
}

/** Bounded reconnect policy. A closed EventSource will never retry on its own,
 * so the component owns the next attempt: short, bounded backoff for a
 * transport drop, then an honest stop rather than an endless "Reconnecting". */
const streamRetryDelaysMs = [1_000, 2_000, 4_000, 8_000, 15_000] as const;
/** Tests may shorten the reconnect schedule; never lengthen it and never add
 * an attempt, so the number of live requests per stream stays fixed. */
export function projectActivityRetryScheduleV1(
  requested?: readonly number[]): readonly number[] {
  if (!requested) return streamRetryDelaysMs;
  if (!Array.isArray(requested) || !Number.isSafeInteger(requested.length) || requested.length < 1
    || requested.length > streamRetryDelaysMs.length) throw new Error("project_activity_retry_schedule_invalid");
  return Object.freeze(requested.map((delay, index) => {
    if (!Number.isSafeInteger(delay) || delay < 1 || delay > streamRetryDelaysMs[index]!)
      throw new Error("project_activity_retry_schedule_invalid");
    return delay;
  }));
}

export function ProjectActivityTimelineV1({ projectId, retryDelaysMs }:
  { projectId: string; retryDelaysMs?: readonly number[] }) {
  const retrySchedule = useMemo(() => projectActivityRetryScheduleV1(retryDelaysMs), [retryDelaysMs]);
  const [state, setState] = useState<ProjectActivityTimelineStateV1>({ state: "loading" });
  const [generation, setGeneration] = useState(0);
  const sourceRef = useRef<EventSource | undefined>(undefined);
  useEffect(() => {
    const abort = new AbortController(); let active = true; let cycle = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined; let countdown: ReturnType<typeof setInterval> | undefined;
    const clearRetry = () => { if (retryTimer) clearTimeout(retryTimer); retryTimer = undefined;
      if (countdown) clearInterval(countdown); countdown = undefined; };
    // The stream response carries no status, so a terminal close cannot be
    // classified here. Re-probe the JSON page once to learn the real reason and
    // then show that honest code. Events already on screen are never discarded.
    const probe = (after: string | null) => {
      clearRetry();
      const before = cycle;
      void readProjectActivityPageV1(projectId, undefined, fetch, abort.signal).then(({ page, olderCursor }) => {
        if (!active || before !== cycle) return;
        cycle = 0;
        setState({ state: "ready", events: page.events, olderCursor, loadingOlder: false, live: "connecting", retryInSeconds: 0 });
        connect(page.nextCursor);
      }, error => {
        if (!active || abort.signal.aborted || before !== cycle) return;
        setState({ state: "unavailable",
          code: error instanceof BrowserRequestError ? error.code : "unavailable" });
      });
    };
    const retry = (after: string | null) => {
      if (!active) return;
      if (cycle >= retrySchedule.length) { probe(after); return; }
      const delay = retrySchedule[cycle]!;
      const seconds = Math.ceil(delay / 1000);
      setState(current => current.state === "ready" ? { ...current, live: "retrying", retryInSeconds: seconds } : current);
      const startedAt = Date.now();
      countdown = setInterval(() => {
        const left = Math.max(0, Math.ceil((delay - (Date.now() - startedAt)) / 1000));
        setState(current => current.state === "ready" ? { ...current, retryInSeconds: left } : current);
      }, 250);
      retryTimer = setTimeout(() => { clearRetry(); cycle++; connect(after); }, delay);
    };
    const connect = (after: string | null) => {
      if (!active) return;
      clearRetry();
      // A fresh source is a fresh attempt: the previous retry countdown and its
      // label must not outlive the request that caused it.
      setState(current => current.state === "ready" ? { ...current, live: "connecting", retryInSeconds: 0 } : current);
      const query = new URLSearchParams({ limit: "100" }); if (after) query.set("after", after);
      const source = new EventSource(`/api/v1/projects/${encodeURIComponent(projectId)}/events?${query}`);
      sourceRef.current = source;
      source.onopen = () => active && setState(current => current.state === "ready" ? { ...current, live: "live" } : current);
      source.addEventListener("project.event", raw => {
        if (!active) return;
        try { const event = parseLiveProjectEventV1((raw as MessageEvent).data, projectId);
          setState(current => current.state === "ready"
            ? { ...current, events: mergeProjectActivityEventsV1(current.events, [event], projectId) } : current); }
        catch { source.close(); setState({ state: "unavailable", code: "unavailable" }); }
      });
      source.addEventListener("stream.head", raw => {
        if (!active) return;
        try {
          const head = parseProjectActivityStreamHeadV1((raw as MessageEvent).data); cycle = 0;
          if (head.hasMore && head.nextCursor) { source.close(); connect(head.nextCursor); return; }
          setState(current => current.state === "ready" ? { ...current, live: "caught_up" } : current);
        } catch { source.close(); setState({ state: "unavailable", code: "unavailable" }); }
      });
      source.addEventListener("stream.reset", () => {
        if (!active) return; source.close(); sourceRef.current = undefined; clearRetry();
        setState({ state: "loading" });
        setGeneration(value => value + 1);
      });
      source.onerror = () => {
        if (!active) return;
        // readyState 0 (CONNECTING) means the browser is already reconnecting on
        // its own and must not be given a second, competing retry. readyState 2
        // (CLOSED) is terminal for this response: after a non-200 stream reply
        // the browser will never retry it, so without this branch the page sits
        // on "Reconnecting" forever with no updates and no recovery control.
        if (source.readyState === 0) {
          setState(current => current.state === "ready" ? { ...current, live: "reconnecting" } : current);
          return;
        }
        source.close(); sourceRef.current = undefined;
        retry(after);
      };
    };
    void readProjectActivityPageV1(projectId, undefined, fetch, abort.signal).then(({ page, olderCursor }) => {
      if (!active) return;
      setState({ state: "ready", events: page.events, olderCursor, loadingOlder: false, live: "connecting", retryInSeconds: 0 });
      connect(page.nextCursor);
    }, error => { if (active && !abort.signal.aborted) setState({ state: "unavailable",
      code: error instanceof BrowserRequestError ? error.code : "unavailable" }); });
    return () => { active = false; abort.abort(); clearRetry(); sourceRef.current?.close(); sourceRef.current = undefined; };
  }, [projectId, generation, retrySchedule]);

  const loadOlder = () => setState(current => {
    if (current.state !== "ready" || !current.olderCursor || current.loadingOlder) return current;
    const before = current.olderCursor; void readProjectActivityPageV1(projectId, before).then(({ page, olderCursor }) => {
      if (page.mode === "reset") { sourceRef.current?.close(); setState({ state: "loading" }); setGeneration(value => value + 1); return; }
      setState(latest => latest.state === "ready" ? { ...latest,
        events: mergeProjectActivityEventsV1(page.events, latest.events, projectId), olderCursor, loadingOlder: false } : latest);
    }, error => setState({ state: "unavailable", code: error instanceof BrowserRequestError ? error.code : "unavailable" }));
    return { ...current, loadingOlder: true };
  });
  return <div className="private-shell"><PrivateHeader /><main id="private-main" tabIndex={-1}>
    <a className="private-back" href={`/projects/${encodeURIComponent(projectId)}`}>← Project overview</a>
    <div className="private-heading"><p className="private-eyebrow">Saved project record</p><h1>Project activity</h1></div>
    <ProjectNavigation projectId={projectId} current="activity" />
    <ProjectActivityTimelineViewV1 state={state} projectId={projectId} onOlder={loadOlder} />
    {state.state === "unavailable" && <div className="private-actions">
      {state.code === "authentication_required" ? <><p>Sign in again in another tab and return here. Checking again never starts work.</p>
        <a href="/cdn-cgi/access/logout">Sign in again</a></>
        : <button type="button" onClick={() => { setState({ state: "loading" }); setGeneration(value => value + 1); }}>
          Check saved activity again</button>}
    </div>}
  </main></div>;
}
