import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PrivateMorningSummary } from "../private-app/app/morning/morning-workspace.tsx";
import { LocalRuntimeContextV1 } from "../private-app/app/local-runtime.tsx";

test("morning summary announces all four sections while loading, with no invented count", () => {
  const html = renderToStaticMarkup(createElement(LocalRuntimeContextV1.Provider,
    { value: { mode: "local", status: { taskWorkersStarted: true, workers: [], projectSections: [] } } },
    createElement(PrivateMorningSummary)));
  for (const heading of ["Finished", "Waiting for you", "Stalled", "PRs opened"])
    assert.match(html, new RegExp(`<h2[^>]*>${heading}`));
  for (const label of ["Loading verified result records…", "Loading saved attention items…", "Loading saved worker signals…"])
    assert.match(html, new RegExp(label));
  // Loading must never show a count pill: `.private-count` only renders for a
  // completed read, the same rule every other saved-state view keeps.
  assert.doesNotMatch(html, /private-count/);
  assert.match(html, /No pull request read is connected to this installation yet\./);
});

/** Mount the real page against a minimal fetch mock and let its effects settle. */
async function mountMorning(fixtures: { activity?: unknown; attention?: unknown }) {
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
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path === "/api/v1/home/tasks") return Response.json(fixtures.activity ?? { active: [], recentResults: [],
      additionalActiveOmitted: false, additionalResultsOmitted: false, resultSource: "not_configured",
      observedAt: "2026-09-29T07:00:00.000Z", startsWork: false });
    if (path === "/api/v1/needs-me/tasks") return Response.json(fixtures.attention ?? { items: [], nextCursor: null,
      examined: 0, observedAt: "2026-09-29T07:00:00.000Z", startsWork: false,
      planningSource: "not_configured", deliverySource: "not_configured",
      sources: { ordinary: "included", ideas: "not_configured" } });
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  const root = createRoot(dom.window.document.getElementById("root")!);
  await React.act(async () => { root.render(React.createElement(LocalRuntimeContextV1.Provider,
    { value: { mode: "local", status: { taskWorkersStarted: true, workers: [{ kind: "codex", state: "unavailable", proof: "not_proven" }], projectSections: [] } } },
    React.createElement(PrivateMorningSummary))); });
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await React.act(async () => { await new Promise(resolve => dom.window.setTimeout(resolve, 5)); });
    if (!/Loading/.test(dom.window.document.body.textContent ?? "")) break;
  }
  const restore = async () => {
    try { await React.act(async () => { root.unmount(); }); } catch { /* already torn down */ }
    dom.window.close();
    for (const [key, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  };
  return { document: dom.window.document, restore };
}

test("a finished result and a waiting task each render their own count and link", async () => {
  const mounted = await mountMorning({
    activity: { active: [], recentResults: [{
      task: { projectId: "project:alpha", requestId: "request:alpha", jobId: "job:done", title: "Nightly research", state: "succeeded",
        version: 1, createdAt: "2026-09-29T02:00:00.000Z", updatedAt: "2026-09-29T03:00:00.000Z", qualityStatus: "accepted" },
      artifact: { artifactId: "artifact:one", attemptId: "attempt:one", runId: "run:one", contentHash: `sha256:${"a".repeat(64)}`,
        sizeBytes: 42, receivedAt: "2026-09-29T03:00:00.000Z", byteCheck: "matched_recorded_claim", qualityAccepted: false },
    }], additionalActiveOmitted: false, additionalResultsOmitted: false, resultSource: "configured",
      observedAt: "2026-09-29T07:00:00.000Z", startsWork: false },
    attention: { items: [{
      task: { projectId: "project:alpha", requestId: "request:beta", jobId: "job:review", title: "Review overnight PR", state: "waiting_approval",
        version: 1, createdAt: "2026-09-29T02:00:00.000Z", updatedAt: "2026-09-29T03:00:00.000Z" },
      inputDigest: `sha256:${"b".repeat(64)}`, reasons: ["review"],
    }], nextCursor: null, examined: 1, observedAt: "2026-09-29T07:00:00.000Z", startsWork: false,
      planningSource: "configured", deliverySource: "configured", sources: { ordinary: "included", ideas: "not_configured" } },
  });
  try {
    const text = mounted.document.body.textContent ?? "";
    assert.match(text, /Nightly research/);
    assert.match(text, /Review overnight PR/);
    assert.ok(mounted.document.querySelector('a[href*="job%3Adone"]'), "the finished result links its exact task");
    assert.ok(mounted.document.querySelector('a[href="/projects/project%3Aalpha/tasks/job%3Areview"]'), "the waiting task links its exact task");
    // One offline local worker (fixture above) is the "stalled" signal.
    assert.match(text, /1 worker signal stale, missing or offline\./);
  } finally { await mounted.restore(); }
});

test("an unavailable read is announced, never folded into an empty section", async () => {
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
  globalThis.fetch = (async () => new Response(null, { status: 500 })) as typeof fetch;
  const root = createRoot(dom.window.document.getElementById("root")!);
  await React.act(async () => { root.render(React.createElement(LocalRuntimeContextV1.Provider,
    { value: { mode: "local", status: { taskWorkersStarted: true, workers: [], projectSections: [] } } },
    React.createElement(PrivateMorningSummary))); });
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await React.act(async () => { await new Promise(resolve => dom.window.setTimeout(resolve, 5)); });
    if (!/Loading/.test(dom.window.document.body.textContent ?? "")) break;
  }
  try {
    const text = dom.window.document.body.textContent ?? "";
    assert.match(text, /Finished work is unavailable\. No zero count or all-clear is inferred\./);
    assert.match(text, /Attention items are unavailable\. No zero count or all-clear is inferred\./);
    assert.doesNotMatch(text, /Nothing finished\.|Nothing is waiting for you\./);
  } finally {
    try { await React.act(async () => { root.unmount(); }); } catch { /* already torn down */ }
    dom.window.close();
    for (const [key, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  }
});
