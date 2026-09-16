import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ScheduleStatusView, ProjectScheduleStatusPanel } from "../private-app/app/schedule-status";
import { readScheduleStatus } from "../src/schedules/browser-client";
import type { ProjectScheduleStatus } from "../src/schedules/status-wire";

const value: ProjectScheduleStatus = {
  projectId: "project:test", observedAt: "2026-09-04T12:00:00.000Z",
  windowEndsAt: "2026-09-11T12:00:00.000Z", automaticExecutionEnabled: false, additionalSchedulesOmitted: false,
  schedules: [{ scheduleId: "schedule:test", state: "active", scheduleType: "interval", timezone: "UTC",
    nextOccurrenceAt: null, nextReason: "anchor_unavailable", additionalOccurrencesOmitted: false,
    occurrences: [{ occurrenceKey: "schedule:test:one", scheduledFor: "2026-09-03T12:00:00.000Z", state: "dispatched", pastDue: false }] }],
};

const remoteNoOccurrence: ProjectScheduleStatus = {
  ...value, schedules: [{ ...value.schedules[0], state: "active", timezone: "America/New_York",
    nextReason: "calculated",
    nextOccurrenceAt: "2026-03-08T07:30:00.000Z", /* EST before spring-forward */
    occurrences: [] }],
};

const remotePaused: ProjectScheduleStatus = {
  ...value, schedules: [{ ...value.schedules[0], state: "paused", nextReason: "paused", nextOccurrenceAt: null, occurrences: [] }],
};

const remoteOmitted: ProjectScheduleStatus = {
  ...value, schedules: [{ ...value.schedules[0], additionalOccurrencesOmitted: true,
    occurrences: [{ occurrenceKey: "schedule:test:a", scheduledFor: "2026-09-03T12:00:00.000Z", state: "pending", pastDue: true },
      { occurrenceKey: "schedule:test:b", scheduledFor: "2026-09-03T13:00:00.000Z", state: "pending", pastDue: true },
      { occurrenceKey: "schedule:test:c", scheduledFor: "2026-09-03T14:00:00.000Z", state: "pending", pastDue: true },
      { occurrenceKey: "schedule:test:d", scheduledFor: "2026-09-03T15:00:00.000Z", state: "pending", pastDue: true }],
  }],
  additionalSchedulesOmitted: true,
};

test("presentation distinguishes forecast, delivery, unavailable and absent data", () => {
  const render = (state: Parameters<typeof ScheduleStatusView>[0]["state"]) => renderToStaticMarkup(createElement(ScheduleStatusView, { projectId: value.projectId, state, onRetry: () => undefined }));
  const html = render({ state: "ready", value });
  assert.match(html, /no interval anchor/);
  assert.match(html, /Delivery recorded — execution unverified/);
  assert.match(html, /does not enable automatic work/);
  assert.match(render({ state: "loading" }), /Loading/);
  const unavailable = render({ state: "unavailable", code: "not_found", message: "nope", projectId: value.projectId });
  assert.match(unavailable, /not available/i);
  assert.match(unavailable, /project may have been closed|moved|not been recorded/i);
  assert.match(unavailable, /Retry/);
  assert.match(render({ state: "ready", value: { ...value, schedules: [] } }), /No schedules are recorded/);
  const wrong = render({ state: "ready", value: { ...value, projectId: "project:other" } });
  assert.doesNotMatch(wrong, /schedule:test/); assert.match(wrong, /unavailable/);
});

test("schedule card exposes saved timezone separately and labels paused/disabled/calculated states", () => {
  const paused = renderToStaticMarkup(createElement(ScheduleStatusView, { projectId: value.projectId, state: { state: "ready", value: remotePaused } }));
  assert.match(paused, /Paused/);
  assert.match(paused, /no next occurrence is calculated/);
  assert.match(paused, /Saved timezone: <code>UTC<\/code>/);
  const omitted = renderToStaticMarkup(createElement(ScheduleStatusView, { projectId: value.projectId, state: { state: "ready", value: remoteOmitted } }));
  assert.match(omitted, /Additional schedules are omitted/);
  assert.match(omitted, /Older occurrence records are omitted/);
  assert.match(omitted, /Retained occurrences \([4] most recent\)/i);
});

test("occurrences render in saved timezone with explicit dispatch/cancel/pending labels", () => {
  const fixtureWithCancelled: ProjectScheduleStatus = {
    ...value, schedules: [{ ...value.schedules[0], occurrences: [
      { occurrenceKey: "schedule:test:a", scheduledFor: "2026-09-03T12:00:00.000Z", state: "dispatched", pastDue: false },
      { occurrenceKey: "schedule:test:b", scheduledFor: "2026-09-03T13:00:00.000Z", state: "cancelled", pastDue: false },
      { occurrenceKey: "schedule:test:c", scheduledFor: "2026-09-03T11:00:00.000Z", state: "pending", pastDue: true },
      { occurrenceKey: "schedule:test:d", scheduledFor: "2026-09-03T10:00:00.000Z", state: "pending", pastDue: false },
    ] }],
  };
  const html = renderToStaticMarkup(createElement(ScheduleStatusView, { projectId: value.projectId, state: { state: "ready", value: fixtureWithCancelled } }));
  assert.match(html, /Delivery recorded — execution unverified/);
  assert.match(html, /Cancelled occurrence/);
  assert.match(html, /Pending past its scheduled time — execution unknown/);
  assert.match(html, /Pending occurrence/);
  const omitted = renderToStaticMarkup(createElement(ScheduleStatusView, { projectId: value.projectId, state: { state: "ready", value: remoteOmitted } }));
  assert.match(omitted, /Pending past its scheduled time — execution unknown/);
  assert.doesNotMatch(html, /forecast has been admitted/i);
  assert.doesNotMatch(html, /execution confirmed/i);
});

test("next occurrence reads in saved timezone and notes display timezone when different", () => {
  const calculated = renderToStaticMarkup(createElement(ScheduleStatusView, { projectId: value.projectId, state: { state: "ready", value: remoteNoOccurrence } }));
  // The display notes the saved timezone (America/New_York) and the UTC instant.
  assert.match(calculated, /Saved timezone: <code>America\/New_York<\/code>/);
  assert.match(calculated, /Mar.*2026/); // formatted in en-US, configured to America/Denver
});

test("browser read is bounded, project-bound and never mutates or follows redirects", async () => {
  const transport: typeof fetch = async (url, options) => {
    assert.equal(url, "/api/v1/projects/project%3Atest/schedules");
    assert.equal(options?.method, "GET"); assert.equal(options?.redirect, "error"); assert.equal(options?.cache, "no-store");
    return Response.json(value);
  };
  assert.deepEqual(await readScheduleStatus(value.projectId, transport), value);
  await assert.rejects(readScheduleStatus("project:other", async () => Response.json(value)), /unavailable/);
  for (const status of [401, 403, 404, 503]) await assert.rejects(readScheduleStatus(value.projectId, async () => new Response(null, { status })));
  await assert.rejects(readScheduleStatus(value.projectId, async () => Response.json({ ...value, automaticExecutionEnabled: true })), /unavailable/);
});

/**
 * Mounted coverage using the repository's existing jsdom + react-dom/client + act
 * pattern. These exercise component behaviour that pure server-render tests
 * cannot reach: focus moves on Enter, disabled duplicate refresh while a read
 * is in flight, request-failure routing, late-response handling.
 *
 * The DOM tests do not prove the 360px physical layout — that requires reserved
 * browser evidence and is recorded as unverified in the package.
 */
async function mountPanel(options: {
  response?: Response | (() => Response);
  delayMs?: number;
} = {}) {
  // @ts-expect-error untyped module
  const jsdomModule = await import("jsdom");
  const JSDOM = (jsdomModule as { JSDOM: unknown }).JSDOM as new (
    html: string, options?: { url?: string; pretendToBeVisual?: boolean },
  ) => { window: Window & typeof globalThis };
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const dom = new JSDOM('<div id="root"></div>', { url: "https://control.invalid/", pretendToBeVisual: true });
  const saved = Object.fromEntries(["window", "document", "IS_REACT_ACT_ENVIRONMENT", "fetch"]
    .map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const requests: Array<{ url: string; aborted: boolean }> = [];
  const resolveResponse = (): Response => {
    if (typeof options.response === "function") return (options.response as () => Response)();
    return options.response ?? Response.json(value);
  };
  globalThis.fetch = ((url: string, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
    const requestUrl = String(url);
    const signal = init?.signal as AbortSignal | undefined;
    if (signal) signal.addEventListener("abort", () => { const entry = requests.find(item => item.url === requestUrl); if (entry) entry.aborted = true; reject(new DOMException("aborted", "AbortError")); });
    requests.push({ url: requestUrl, aborted: false });
    if ((options.delayMs ?? 0) > 0) {
      setTimeout(() => resolve(resolveResponse()), options.delayMs);
    } else {
      resolve(resolveResponse());
    }
  })) as typeof fetch;
  const root = createRoot(dom.window.document.getElementById("root")!);
  const { act } = React;
  await act(async () => { root.render(React.createElement(ProjectScheduleStatusPanel, { projectId: value.projectId })); });
  const restore = async () => {
    try { await act(async () => { root.unmount(); }); } catch { /* already torn down */ }
    await new Promise(resolve => setImmediate(resolve));
    dom.window.close();
    for (const [key, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  };
  return { dom, root, requests, act, restore };
}

test("mounted panel: refresh button is disabled while a read is in flight", async () => {
  const handle = await mountPanel({ delayMs: 30 });
  try {
    await handle.act(async () => { await new Promise(resolve => handle.dom.window.setTimeout(resolve, 5)); });
    const button = handle.dom.window.document.querySelector("button");
    assert.ok(button, "expected refresh button");
    assert.equal(button?.textContent?.trim(), "Refreshing…");
    assert.equal(button?.hasAttribute("disabled"), true);
    for (let attempt = 0; attempt < 200 && button?.hasAttribute("disabled"); attempt += 1) {
      await handle.act(async () => { await new Promise(resolve => handle.dom.window.setTimeout(resolve, 10)); });
    }
    assert.equal(button?.hasAttribute("disabled"), false);
  } finally { await handle.restore(); }
});

test("mounted panel: each request failure renders an actionable heading and retry button", async () => {
  for (const [status, expected] of [
    [401, /Your session has ended/i],
    [403, /do not have access/i],
    [404, /not available/i],
    [503, /unavailable/i],
  ] as const) {
    const handle = await mountPanel({ response: () => new Response(null, { status }) });
    try {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const alert = handle.dom.window.document.querySelector("[role='alert']");
        if (alert) break;
        await handle.act(async () => { await new Promise(resolve => handle.dom.window.setTimeout(resolve, 10)); });
      }
      const html = handle.dom.window.document.body.innerHTML;
      assert.match(html, expected, `status=${status}`);
      const retry = [...handle.dom.window.document.querySelectorAll("button")].find(button => /retry|sign in/i.test(button.textContent ?? ""));
      assert.ok(retry, `retry button missing for status=${status}`);
    } finally { await handle.restore(); }
  }
});

test("mounted panel: a delayed first response never races a second refresh", async () => {
  const handle = await mountPanel({ delayMs: 80 });
  try {
    // Wait for the first fetch to land so the refresh button becomes enabled.
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const button = handle.dom.window.document.querySelector("button");
      if (button && !button.hasAttribute("disabled")) break;
      await handle.act(async () => { await new Promise(resolve => handle.dom.window.setTimeout(resolve, 10)); });
    }
    const button = handle.dom.window.document.querySelector("button") as HTMLButtonElement | null;
    assert.ok(button);
    assert.equal(button?.hasAttribute("disabled"), false);
    // Click refresh; the second request replaces the first because the effect
    // aborts the in-flight read when generation changes.
    await handle.act(async () => { button.click(); });
    await handle.act(async () => { await new Promise(resolve => handle.dom.window.setTimeout(resolve, 200)); });
    const aborted = handle.requests.filter(item => item.aborted).length;
    assert.ok(aborted >= 1, `expected at least one aborted request, got ${aborted}; requests=${JSON.stringify(handle.requests)}`);
    assert.ok(handle.requests.length >= 2, `expected at least two requests, got ${handle.requests.length}`);
  } finally { await handle.restore(); }
});

test("mounted panel: Enter on refresh triggers a new request and announces the new observedAt", async () => {
  const second: ProjectScheduleStatus = { ...value, observedAt: "2026-09-05T12:00:00.000Z" };
  const handle = await mountPanel({ response: () => Response.json(second) });
  try {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (handle.dom.window.document.body.textContent?.includes("Refresh")) break;
      await handle.act(async () => { await new Promise(resolve => handle.dom.window.setTimeout(resolve, 10)); });
    }
    const button = handle.dom.window.document.querySelector("button") as HTMLButtonElement | null;
    assert.ok(button);
    button.focus();
    await handle.act(async () => {
      button.dispatchEvent(new handle.dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      button.click();
    });
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if ((handle.dom.window.document.body.textContent ?? "").includes("2026-09-05")) break;
      await handle.act(async () => { await new Promise(resolve => handle.dom.window.setTimeout(resolve, 10)); });
    }
    assert.match(handle.dom.window.document.body.textContent ?? "", /2026-09-05/);
    assert.match(handle.dom.window.document.body.textContent ?? "", /Schedules refreshed/);
  } finally { await handle.restore(); }
});
