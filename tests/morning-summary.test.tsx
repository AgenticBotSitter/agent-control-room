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
  for (const heading of ["Recent results", "Waiting for you", "Stalled", "PRs opened"])
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

// R4U-11: "the red attention count says 25 when 301 items are waiting".
//
// `readTaskAttention` reads ONE bounded page (the wire caps `examined` at 25) and
// returns `nextCursor` when more exist. Two count sites rendered `items.length`
// with no reference to that cursor, so on a tenant with more attention than fits
// in one page the owner was told a specific, smaller number than the truth. The
// header badge already got this right -- it reports "N+" -- and two of the three
// sites did not, which is the same information presented two different ways on
// two screens the owner reads side by side.
//
// The fix is a shared helper rather than a "+" typed at each site: the number a
// truncated page may honestly claim is a function of the page, and three copies
// of that function would drift exactly the way the three copies of the bug did.
test("a truncated attention page reports 25+, never a smaller exact count", async () => {
  const page = (items: number, nextCursor: string | null) => ({ items: Array.from({ length: items }, (_, index) => ({
    task: { projectId: "project:alpha", requestId: `request:${index}`, jobId: `job:${index}`,
      title: `Waiting item ${index}`, state: "waiting_approval", version: 1,
      createdAt: "2026-09-29T02:00:00.000Z", updatedAt: "2026-09-29T03:00:00.000Z" },
    inputDigest: `sha256:${"b".repeat(64)}`, reasons: ["review"] })), nextCursor,
    examined: items, observedAt: "2026-09-29T07:00:00.000Z", startsWork: false,
    planningSource: "configured", deliverySource: "configured",
    sources: { ordinary: "included", ideas: "not_configured" } });

  // The COUNT PILL, not the page text. Asserting against the whole body would
  // pass on any "+" anywhere, which is exactly the mistake this test would have
  // made while it stayed green: it read as covering the case and covered nothing.
  const countOf = (document: Document) => {
    const panel = document.querySelector('[aria-labelledby="morning-waiting"]')!;
    return panel.querySelector(".private-count")?.textContent ?? null;
  };
  const truncated = await mountMorning({ attention: page(25, "project:alpha") });
  try {
    assert.equal(countOf(truncated.document), "25+",
      "Morning claimed an exact count on a page with a next cursor");
    assert.match(truncated.document.body.textContent ?? "", /Waiting item 0/,
      "the items are still listed; only the number is wrong");
  } finally { await truncated.restore(); }

  const complete = await mountMorning({ attention: page(3, null) });
  try {
    assert.equal(countOf(complete.document), "3",
      "a complete page has no more items, so a '+' on it would claim work that does not exist");
  } finally { await complete.restore(); }

  // The Stalled panel is a SECOND pill on the same page reading a different
  // saved read. It must be read independently, or one assertion could be
  // standing in for the other.
  const bothPills = await mountMorning({ attention: page(25, "project:alpha") });
  try {
    const pills = [...bothPills.document.querySelectorAll(".private-count")].map(node => node.textContent);
    assert.deepEqual(pills, ["25+", "1"],
      `the truncated attention pill and the stalled-worker pill must be read separately: ${JSON.stringify(pills)}`);
  } finally { await bothPills.restore(); }
});

test("R7-05 Morning recent-result count reports a floor only when more results were omitted", async () => {
  for (const omitted of [true, false]) {
    const mounted = await mountMorning({ activity: {
      active: [], recentResults: Array.from({ length: 10 }, (_, i) => ({
        task: { projectId: "project:alpha", requestId: `request:${i}`, jobId: `job:${i}`, title: `Result ${i}`,
          state: "succeeded", version: 1, createdAt: "2026-09-29T02:00:00.000Z", updatedAt: "2026-09-29T03:00:00.000Z" },
        artifact: { artifactId: `artifact:${i}`, attemptId: `attempt:${i}`, runId: `run:${i}`,
          contentHash: `sha256:${"a".repeat(64)}`, sizeBytes: 42, receivedAt: "2026-09-29T03:00:00.000Z",
          byteCheck: "matched_recorded_claim", qualityAccepted: false } })),
      additionalActiveOmitted: false, additionalResultsOmitted: omitted, resultSource: "configured",
      observedAt: "2026-09-29T07:00:00.000Z", startsWork: false } });
    try {
      assert.equal(mounted.document.querySelector('[aria-labelledby="morning-finished"] .private-count')?.textContent,
        omitted ? "10+" : "10");
      assert.ok(mounted.document.querySelector('a[href*="job%3A0"]'));
    } finally { await mounted.restore(); }
  }
});

test("R7-06 Morning describes recent saved results without claiming a last-check window", async () => {
  const loading = renderToStaticMarkup(createElement(PrivateMorningSummary));
  assert.doesNotMatch(loading, /since Control Room last checked|since you last looked|everything/i);
  assert.match(loading, /Recent results/);
  const mounted = await mountMorning({ activity: { active: [], recentResults: [],
    additionalActiveOmitted: false, additionalResultsOmitted: false, resultSource: "configured",
    observedAt: "2026-09-29T07:00:00.000Z", startsWork: false } });
  try {
    const panel = mounted.document.querySelector('[aria-labelledby="morning-finished"]')!;
    assert.match(panel.textContent ?? "", /Recent results0No recent results are recorded\./);
    assert.doesNotMatch(mounted.document.body.textContent ?? "", /Nothing finished|since Control Room last checked/);
  } finally { await mounted.restore(); }
});
