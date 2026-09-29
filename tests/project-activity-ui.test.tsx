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
    state: { state: "ready", events: [], olderCursor: null, loadingOlder: false, live: "caught_up", retryInSeconds: 0 } }));
  const unavailable = renderToStaticMarkup(createElement(ProjectActivityTimelineViewV1, { projectId,
    state: { state: "unavailable", code: "unavailable" } }));
  const ready = renderToStaticMarkup(createElement(ProjectActivityTimelineViewV1, { projectId,
    state: { state: "ready", events: [event], olderCursor: "older-cursor-value", loadingOlder: false, live: "live", retryInSeconds: 0 } }));
  assert.match(loading, /Loading saved project activity/); assert.doesNotMatch(loading, /No saved project events/);
  assert.match(empty, /No saved project events are recorded yet/); assert.doesNotMatch(empty, /unavailable/);
  assert.match(unavailable, /source is unavailable/); assert.doesNotMatch(unavailable, /No saved project events/);
  assert.match(ready, /Project activity recorded/); assert.match(ready, /Load older activity/);
  for (const html of [loading, empty, unavailable, ready]) assert.doesNotMatch(html, />\s*(Approve|Dispatch|Retry work)\s*</i);
  const retrying = renderToStaticMarkup(createElement(ProjectActivityTimelineViewV1, { projectId,
    state: { state: "ready", events: [event], olderCursor: null, loadingOlder: false, live: "retrying", retryInSeconds: 4 } }));
  assert.match(retrying, /Retrying in\s*4 seconds/);
  assert.match(retrying, /Project activity recorded/, "a stream retry never discards the events already shown");
  const sessionEnded = renderToStaticMarkup(createElement(ProjectActivityTimelineViewV1, { projectId,
    state: { state: "unavailable", code: "authentication_required" } }));
  assert.match(sessionEnded, /Sign in again/); assert.doesNotMatch(sessionEnded, /Check saved activity again/);
});

test("B-093 a terminal stream response retries with backoff, then reports the honest error", async () => {
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
    /** A non-200 stream response: the browser gives up and never retries. */
    fail(status: number) { this.readyState = FakeEventSource.CLOSED; this.status = status; this.onerror?.(); }
    status = 200;
  }
  const sources: FakeEventSource[] = []; let reads = 0; let probeStatus = 200;
  const originCursor = encodeProjectEventOriginCursorV1(projectId);
  const page = buildProjectEventPageV1({ tenantId: "tenant:timeline-ui", workspaceId: "workspace:timeline-ui", projectId,
    mode: "snapshot", events: [event], nextCursor: originCursor, hasMore: false, truncatedBefore: false });
  const text = () => dom.window.document.body.textContent ?? "";
  try {
    Object.assign(globalThis, { window: dom.window, document: dom.window.document, EventSource: FakeEventSource,
      fetch: async () => { reads++; return probeStatus === 200 ? Response.json({ page, olderCursor: null })
        : new Response("no", { status: probeStatus }); } });
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
    const root = createRoot(dom.window.document.getElementById("root")!);
    await act(async () => { root.render(createElement(ProjectActivityTimelineV1, { projectId, retryDelaysMs: [300, 20, 20] }));
      await new Promise(resolve => setTimeout(resolve, 0)); });
    assert.equal(sources.length, 1); assert.equal(reads, 1);
    assert.match(text(), /Project activity recorded/);

    // A transport drop the browser is still retrying must not get a second,
    // competing retry from the component.
    await act(async () => { sources[0]!.readyState = FakeEventSource.CONNECTING; sources[0]!.onerror?.(); });
    assert.match(text(), /Reconnecting/); assert.equal(sources.length, 1);

    // A closed EventSource (a 503 stream response) is terminal for the browser.
    // The component must retry on its own instead of freezing on "Reconnecting".
    await act(async () => { sources[0]!.fail(503); });
    assert.match(text(), /Retrying in\s*1 second/, "a terminal stream error shows a bounded countdown");
    assert.match(text(), /Project activity recorded/, "events already shown survive the reconnect");
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 400)); });
    assert.equal(sources.length, 2, "a terminal stream error schedules a bounded reconnect");
    assert.doesNotMatch(text(), /Retrying in/, "the countdown is cleared once the new source exists");

    // Exhaust the whole bounded schedule, then report an honest error.
    probeStatus = 503;
    for (const wait of [40, 40, 40]) {
      await act(async () => { sources.at(-1)!.fail(503); await new Promise(resolve => setTimeout(resolve, wait)); });
    }
    await act(async () => { sources.at(-1)!.fail(503); await new Promise(resolve => setTimeout(resolve, 30)); });
    assert.equal(sources.length, 4, "the schedule is bounded: one initial source plus three retries");
    assert.ok(reads >= 2, "the terminal path re-probes /activity to learn the real error code");
    assert.match(text(), /source is unavailable/);
    assert.match(text(), /Check saved activity again/, "a 503 offers an honest retry, never a false all-clear");
    assert.doesNotMatch(text(), /No saved project events are recorded yet/);
    await act(async () => root.unmount());

    // A 401 that ends the session while the stream is already open must go to
    // sign-in, not to a generic retry button. EventSource carries no status, so
    // the component learns this from the re-probe.
    sources.length = 0; reads = 0;
    const after = new JSDOM('<div id="root"></div>', { url: "https://control.invalid/", pretendToBeVisual: true });
    let probe = 200;
    Object.assign(globalThis, { window: after.window, document: after.window.document, EventSource: FakeEventSource,
      fetch: async () => { reads++; return probe === 200 ? Response.json({ page, olderCursor: null })
        : new Response("no", { status: probe }); } });
    const signedOut = createRoot(after.window.document.getElementById("root")!);
    await act(async () => { signedOut.render(createElement(ProjectActivityTimelineV1, { projectId, retryDelaysMs: [20, 20, 20] }));
      await new Promise(resolve => setTimeout(resolve, 0)); });
    probe = 401;
    for (const wait of [40, 40, 40, 30]) {
      await act(async () => { sources.at(-1)!.fail(401); await new Promise(resolve => setTimeout(resolve, wait)); });
    }
    assert.match(after.window.document.body.textContent ?? "", /session has ended/);
    assert.doesNotMatch(after.window.document.textContent ?? "", /Check saved activity again/,
      "an ended session is not offered a retry that cannot succeed");
    await act(async () => signedOut.unmount());
    after.window.close();
  } finally {
    for (const [key, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete (globalThis as Record<string, unknown>)[key];
    }
    dom.window.close();
  }
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
