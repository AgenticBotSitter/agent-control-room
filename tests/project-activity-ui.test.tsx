import assert from "node:assert/strict";
import { createElement } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import test from "node:test";
import { ProjectActivityTimelineV1, ProjectActivityTimelineViewV1 } from "../private-app/app/project-activity-timeline";
import { buildProjectEventPageV1, buildProjectEventV1, encodeProjectEventCursorV1,
  encodeProjectEventOriginCursorV1, PROJECT_EVENT_INPUT_V1 } from "../src/project-events/v1";
import { sha256Digest } from "../src/security";

const projectId = "project:timeline-ui", now = "2026-09-28T12:00:00.000Z";
const event = buildProjectEventV1({ schemaVersion: PROJECT_EVENT_INPUT_V1, tenantId: "tenant:timeline-ui",
  workspaceId: "workspace:timeline-ui", projectId, eventId: "event:timeline-ui:1", eventKind: "project",
  source: { kind: "control_room", sourceId: "source:timeline-ui:1", sourceVersion: "version-1",
    sourceEventKeyDigest: sha256Digest({ source: 1 }) }, subject: { kind: "project", subjectId: projectId },
  safeSummary: "Project activity recorded", tone: "good", occurredAt: now, presentationOnly: true,
  grantsApproval: false, grantsCommandAuthority: false, grantsExecutionAuthority: false }, 1, null, now);

test("B-093 keeps loading, empty, unavailable, and recorded activity states distinct", () => {
  const loading = renderToStaticMarkup(createElement(ProjectActivityTimelineViewV1, { projectId, state: { state: "loading" } }));
  const empty = renderToStaticMarkup(createElement(ProjectActivityTimelineViewV1, { projectId,
    state: { state: "ready", events: [], olderCursor: null, loadingOlder: false, live: "caught_up" } }));
  const unavailable = renderToStaticMarkup(createElement(ProjectActivityTimelineViewV1, { projectId,
    state: { state: "unavailable", code: "unavailable" } }));
  const ready = renderToStaticMarkup(createElement(ProjectActivityTimelineViewV1, { projectId,
    state: { state: "ready", events: [event], olderCursor: "older-cursor-value", loadingOlder: false, live: "live" } }));
  assert.match(loading, /Loading saved project activity/); assert.doesNotMatch(loading, /No saved project events/);
  assert.match(empty, /No saved project events are recorded yet/); assert.doesNotMatch(empty, /unavailable/);
  assert.match(unavailable, /source is unavailable/); assert.doesNotMatch(unavailable, /No saved project events/);
  assert.match(ready, /Project activity recorded/); assert.match(ready, /Load older activity/);
  for (const html of [loading, empty, unavailable, ready]) assert.doesNotMatch(html, />\s*(Approve|Dispatch|Retry work)\s*</i);
});

test("B-093 an empty snapshot establishes a replay cursor, drains bounded pages, and safely resets", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "https://control.invalid/", pretendToBeVisual: true });
  const saved = Object.fromEntries(["window", "document", "fetch", "EventSource", "IS_REACT_ACT_ENVIRONMENT"]
    .map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  class FakeEventSource {
    static readonly CONNECTING = 0; static readonly OPEN = 1; static readonly CLOSED = 2;
    readonly url: string; readyState = FakeEventSource.CONNECTING; onopen: (() => void) | null = null;
    onerror: (() => void) | null = null; closed = false;
    private readonly listeners = new Map<string, ((event: { data: string }) => void)[]>();
    constructor(url: string) { this.url = url; sources.push(this); }
    addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
      const callback = listener as unknown as (event: { data: string }) => void;
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), callback]);
    }
    close() { this.closed = true; this.readyState = FakeEventSource.CLOSED; }
    emit(type: string, data = "") { for (const listener of this.listeners.get(type) ?? []) listener({ data }); }
  }
  const sources: FakeEventSource[] = []; let reads = 0;
  const originCursor = encodeProjectEventOriginCursorV1(projectId);
  const page = buildProjectEventPageV1({ tenantId: "tenant:timeline-ui", workspaceId: "workspace:timeline-ui", projectId,
    mode: "snapshot", events: [], nextCursor: originCursor, hasMore: false, truncatedBefore: false });
  try {
    Object.assign(globalThis, { window: dom.window, document: dom.window.document,
      EventSource: FakeEventSource, fetch: async () => { reads++; return Response.json({ page, olderCursor: null }); } });
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
    const root = createRoot(dom.window.document.getElementById("root")!);
    await act(async () => { root.render(createElement(ProjectActivityTimelineV1, { projectId }));
      await new Promise(resolve => setTimeout(resolve, 0)); });
    assert.equal(reads, 1); assert.equal(sources.length, 1);
    assert.equal(new URL(sources[0]!.url, dom.window.location.href).searchParams.get("after"), originCursor);
    const eventCursor = encodeProjectEventCursorV1(event);
    await act(async () => { sources[0]!.emit("stream.head", JSON.stringify({ mode: "replay", nextCursor: eventCursor,
      hasMore: true, truncatedBefore: false, pageDigest: sha256Digest({ page: "first-replay" }) })); });
    assert.equal(sources[0]!.closed, true); assert.equal(sources.length, 2);
    assert.equal(new URL(sources[1]!.url, dom.window.location.href).searchParams.get("after"), eventCursor);
    await act(async () => { sources[1]!.emit("stream.reset"); await new Promise(resolve => setTimeout(resolve, 0)); });
    assert.equal(sources[1]!.closed, true); assert.equal(reads, 2); assert.equal(sources.length, 3);
    assert.match(dom.window.document.body.textContent ?? "", /No saved project events are recorded yet/);
    await act(async () => root.unmount());
  } finally {
    for (const [key, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete (globalThis as Record<string, unknown>)[key];
    }
    dom.window.close();
  }
});
