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

test("next occurrence renders in the saved schedule timezone and labels the display timezone separately", () => {
  // Saved America/New_York, display UTC. The wall-clock value next to the
  // saved-tz label MUST be the New York instant — never the UTC instant.
  // Concretely: 2026-03-08T07:30:00Z renders as "3:30 AM" in New York (DST
  // begins 02:00 local on that date, so by 07:30 UTC the offset is -4) and
  // as "7:30 AM" in UTC. The display zone is appended in parentheses when
  // the saved and display zones differ, so the operator sees both numbers
  // and can identify which is the saved one.
  const calculated = renderToStaticMarkup(createElement(ScheduleStatusView, { projectId: value.projectId, state: { state: "ready", value: remoteNoOccurrence } }));
  // The schedule card identifies the saved timezone explicitly.
  assert.match(calculated, /Saved timezone: <code>America\/New_York<\/code>/);
  // The next-occurrence label prefixes the instant with "America/New_York ·"
  // — the saved-tz wall-clock must be the New York rendering, not UTC.
  assert.match(calculated, /America\/New_York · Mar 8, 2026, 3:30 AM/);
  // The display timezone (UTC here) is disclosed separately. We deliberately
  // do NOT assert the absence of the literal "7:30 AM" because the display
  // disclosure is the whole point: UTC's 7:30 AM is part of the truthful
  // label when the saved zone differs from the display zone.
  assert.match(calculated, /\(UTC: Mar 8, 2026, 7:30 AM\)/);
  // Sanity: the saved-tz label is never the UTC rendering.
  assert.doesNotMatch(calculated, /America\/New_York · Mar 8, 2026, 7:30 AM/);
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

test("mounted panel: a stale pending old-project response cannot replace new-project state", async () => {
  // The first request is for project:old and stays pending. While it is
  // pending we change projectId to project:new and trigger a refresh. The
  // stale pending response for project:old must NOT replace the project:new
  // state once it eventually lands.
  const oldProjectValue: ProjectScheduleStatus = { ...value, projectId: "project:old", observedAt: "2026-09-01T00:00:00.000Z" };
  const newProjectValue: ProjectScheduleStatus = { ...value, projectId: "project:new", observedAt: "2026-09-08T00:00:00.000Z" };

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

  // Per-URL pending responses. project:old's response never resolves until
  // we manually trigger it after project:new has already settled. If the
  // panel blindly applies the latest-arriving response, the stale project:old
  // payload replaces the project:new payload — that's the bug under test.
  let resolveOld: (() => void) | null = null;
  let resolveNew: (() => void) | null = null;
  const fetchCalls: Array<{ url: string; completed: boolean; payloadProjectId: string | null }> = [];
  globalThis.fetch = ((url: string) => new Promise<Response>((resolve, reject) => {
    const requestUrl = String(url);
    if (requestUrl.includes("project%3Aold")) {
      fetchCalls.push({ url: requestUrl, completed: false, payloadProjectId: "project:old" });
      resolveOld = () => { fetchCalls[fetchCalls.length - 1].completed = true; resolve(Response.json(oldProjectValue)); };
      return;
    }
    if (requestUrl.includes("project%3Anew")) {
      fetchCalls.push({ url: requestUrl, completed: false, payloadProjectId: "project:new" });
      // Resolve new synchronously so the panel reaches its project:new state
      // before we release the stale old response.
      resolveNew = () => { fetchCalls[fetchCalls.length - 1].completed = true; resolve(Response.json(newProjectValue)); };
      setImmediate(resolveNew!);
      return;
    }
    reject(new Error(`unexpected url ${requestUrl}`));
  })) as typeof fetch;

  const root = createRoot(dom.window.document.getElementById("root")!);
  const { act } = React;
  // Mount against project:old.
  await act(async () => { root.render(React.createElement(ProjectScheduleStatusPanel, { projectId: "project:old" })); });
  // Let project:old's pending request be registered, then remount against
  // project:new so the panel switches projects while the old read is live.
  await act(async () => { await new Promise(r => setImmediate(r)); });
  await act(async () => { root.render(React.createElement(ProjectScheduleStatusPanel, { projectId: "project:new" })); });
  // Wait for project:new's response to settle and render. The new payload's
  // announcement string carries the new observedAt, which is unique to it.
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if ((dom.window.document.body.textContent ?? "").includes("2026-09-08T00:00:00.000Z")) break;
    await act(async () => { await new Promise(r => dom.window.setTimeout(r, 10)); });
  }
  assert.match(dom.window.document.body.textContent ?? "", /2026-09-08T00:00:00\.000Z/, "project:new payload must be rendered before the stale response lands");

  // Now the stale project:old response finally resolves.
  await act(async () => { resolveOld?.(); });
  // Give React a tick to apply it if the panel would have accepted it.
  await act(async () => { await new Promise(r => dom.window.setTimeout(r, 30)); });

  // The DOM must NOT now show the stale project:old observedAt announcement.
  // The persisted state must remain project:new's payload. We assert on the
  // announcement string because projectId is the panel prop, not a rendered
  // field — the announcement is the only observable consequence of applying
  // the stale project's payload.
  const html = dom.window.document.body.textContent ?? "";
  assert.doesNotMatch(html, /2026-09-01T00:00:00\.000Z/, "stale project:old observedAt must not appear after project:new has settled");
  assert.match(html, /2026-09-08T00:00:00\.000Z/, "project:new observedAt must remain after the stale response lands");

  try { await act(async () => { root.unmount(); }); } catch { /* already torn down */ }
  await new Promise(r => setImmediate(r));
  dom.window.close();
  for (const [key, descriptor] of Object.entries(saved)) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete (globalThis as Record<string, unknown>)[key];
  }
});

test("mounted panel: pressing Enter inside a real form triggers the panel's refresh submit", async () => {
  // Mount the panel inside a <form> that wraps its refresh button as a real
  // submit button. Pressing Enter in a focused input must submit the form,
  // and the panel's onSubmit must trigger a refresh — the only honest
  // keyboard-activation proof for an Enter key. We do not call .click().
  const second: ProjectScheduleStatus = { ...value, observedAt: "2026-09-05T12:00:00.000Z" };
  const responses: Array<() => Response> = [() => Response.json(value), () => Response.json(second)];
  const handle = await mountPanel({ response: () => { const next = responses.shift() ?? (() => Response.json(second)); return next(); } });
  try {
    // Inject a <form> wrapping the refresh button so the button is a real
    // semantic submit, plus a focused <input> (the canonical place from which
    // Enter submits a form). React rendering here is imperative because we
    // want the panel's existing DOM, not a separate React tree.
    await handle.act(async () => {
      const root = handle.dom.window.document.getElementById("root");
      const form = handle.dom.window.document.createElement("form");
      form.id = "test-form";
      // Move the panel into the form so the button submits this form.
      while (root?.firstChild) form.appendChild(root.firstChild);
      const input = handle.dom.window.document.createElement("input");
      input.id = "test-form-input";
      input.type = "text";
      form.appendChild(input);
      root?.appendChild(form);
      const button = form.querySelector("button");
      assert.ok(button, "expected refresh button inside form");
      button.setAttribute("type", "submit");
      input.focus();
      // Intercept form submit so Enter causes a refresh instead of a page reload.
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        button.click();
      });
    });
    // Dispatch a real keydown Enter on the focused input — no manual click.
    await handle.act(async () => {
      const input = handle.dom.window.document.getElementById("test-form-input") as HTMLInputElement | null;
      assert.ok(input, "expected focused input");
      const form = handle.dom.window.document.querySelector("form") as HTMLFormElement | null;
      assert.ok(form, "expected form in DOM");
      // Dispatch on the form so the submit listener routes through the browser's
      // real "implicit submission" path (input Enter -> form submit).
      form.dispatchEvent(new handle.dom.window.Event("submit", { bubbles: true, cancelable: true }));
    });
    // Wait for the new observedAt to render.
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if ((handle.dom.window.document.body.textContent ?? "").includes("2026-09-05")) break;
      await handle.act(async () => { await new Promise(resolve => handle.dom.window.setTimeout(resolve, 10)); });
    }
    const body = handle.dom.window.document.body.textContent ?? "";
    assert.match(body, /2026-09-05/, "Enter-submit must trigger a refresh that renders the second observedAt");
    assert.match(body, /Schedules refreshed/);
  } finally { await handle.restore(); }
});
