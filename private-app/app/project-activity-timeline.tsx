"use client";

import { useEffect, useRef, useState } from "react";
import type { ProjectEventV1 } from "../../src/project-events/v1/types";
import { BrowserRequestError } from "../../src/web/v1/browser-request-error";
import { mergeProjectActivityEventsV1, parseLiveProjectEventV1, parseProjectActivityStreamHeadV1,
  readProjectActivityPageV1 } from "../../src/web/v1/project-activity-browser-client";
import { ConfiguredTimestamp } from "./configured-timestamp";
import { PrivateHeader } from "./private-header";
import { ProjectNavigation } from "./project-navigation";

type LiveState = "connecting" | "live" | "caught_up" | "reconnecting";
export type ProjectActivityTimelineStateV1 = { state: "loading" }
  | { state: "unavailable"; code: BrowserRequestError["code"] }
  | { state: "ready"; events: readonly ProjectEventV1[]; olderCursor: string | null; loadingOlder: boolean; live: LiveState };

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
  </section>;
  return <section className="private-panel"><div className="private-heading"><div><p className="private-eyebrow">Append-only project record</p>
    <h2>Activity timeline</h2></div><span className="private-state" aria-live="polite">{label(state.live)}</span></div>
    <p className="private-note">Read-only history. Loading, reconnecting, and checking older events never approves, dispatches, retries, or changes work.</p>
    {state.events.length ? <ol className="private-dashboard-list">{[...state.events].reverse().map(event => <li key={event.eventDigest}>
      <strong>{event.safeSummary}</strong><span>{label(event.eventKind)} · <ConfiguredTimestamp value={event.occurredAt} prefix="Occurred" /></span>
      {event.safeDetail && <p>{event.safeDetail}</p>}{event.deepLinkPath && <a href={event.deepLinkPath}>Open related record</a>}
    </li>)}</ol> : <p>No saved project events are recorded yet.</p>}
    {state.olderCursor && <button type="button" disabled={state.loadingOlder} onClick={onOlder}>
      {state.loadingOlder ? "Loading older activity…" : "Load older activity"}</button>}
    <span className="private-note">Project {projectId}</span>
  </section>;
}

export function ProjectActivityTimelineV1({ projectId }: { projectId: string }) {
  const [state, setState] = useState<ProjectActivityTimelineStateV1>({ state: "loading" });
  const [generation, setGeneration] = useState(0);
  const sourceRef = useRef<EventSource | undefined>(undefined);
  useEffect(() => {
    const abort = new AbortController(); let active = true; let cycle = 0;
    const connect = (after: string | null) => {
      if (!active) return;
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
        if (!active) return; source.close(); sourceRef.current = undefined; setState({ state: "loading" });
        setGeneration(value => value + 1);
      });
      source.onerror = () => { if (!active) return; cycle++;
        setState(current => current.state === "ready" ? { ...current, live: "reconnecting" } : current);
        if (cycle >= 3) { source.close(); setState({ state: "unavailable", code: "unavailable" }); } };
    };
    void readProjectActivityPageV1(projectId, undefined, fetch, abort.signal).then(({ page, olderCursor }) => {
      if (!active) return;
      setState({ state: "ready", events: page.events, olderCursor, loadingOlder: false, live: "connecting" });
      connect(page.nextCursor);
    }, error => { if (active && !abort.signal.aborted) setState({ state: "unavailable",
      code: error instanceof BrowserRequestError ? error.code : "unavailable" }); });
    return () => { active = false; abort.abort(); sourceRef.current?.close(); sourceRef.current = undefined; };
  }, [projectId, generation]);

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
    {state.state === "unavailable" && <button type="button" onClick={() => { setState({ state: "loading" }); setGeneration(value => value + 1); }}>
      Check saved activity again</button>}
  </main></div>;
}
