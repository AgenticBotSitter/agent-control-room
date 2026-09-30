import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ScorecardGroupRow, WorkersScorecard } from "../private-app/app/workers/workers-scorecard";
import { readWorkerScorecardV1, type WorkerScorecardReadV1 } from "../src/web/v1/worker-scorecard-browser-client";
import { DatabaseWorkerScorecardReadSourceV1 } from "../src/web/v1/worker-scorecard-read";

const group: WorkerScorecardReadV1["groups"][number] = { workerKind: "codex", model: "sol", effort: "high",
  provider: null, profile: null,
  last7Days: { finished: 3, passedFirstTime: 2, neededFixes: 1, failedOrBlocked: 0, caughtBy: [{ label: "Claude checker", count: 1 }] },
  last30Days: { finished: 3, passedFirstTime: 2, neededFixes: 1, failedOrBlocked: 0, caughtBy: [{ label: "Claude checker", count: 1 }] } };

test("a scorecard row names the worker and model and reports pass/fix/block counts without inventing a rate", () => {
  const html = renderToStaticMarkup(createElement(ScorecardGroupRow, { group }));
  assert.match(html, /Codex — sol\/high/);
  assert.match(html, /3 finished/); assert.match(html, /2 passed first time/);
  assert.match(html, /1 needed fixes/); assert.match(html, /0 failed or blocked/);
  assert.match(html, /caught by Claude checker \(1\)/);
});

test("a window with nothing finished says so instead of showing zeroes", () => {
  const empty: WorkerScorecardReadV1["groups"][number] = { ...group,
    last7Days: { finished: 0, passedFirstTime: 0, neededFixes: 0, failedOrBlocked: 0, caughtBy: [] } };
  const html = renderToStaticMarkup(createElement(ScorecardGroupRow, { group: empty }));
  assert.match(html, /<p class="private-note">Last 7 days: no build stage finished\.<\/p>/);
});

test("scorecard browser read is bounded GET-only and rejects untrusted response shapes", async () => {
  let init: RequestInit | undefined;
  const available = await readWorkerScorecardV1(async (_input, options) => { init = options; return Response.json({ observedAt: "2026-09-29T12:00:00.000Z", groups: [] }); });
  assert.equal(available.state, "available"); assert.equal(init?.method, "GET"); assert.equal(init?.cache, "no-store");
  const invalid = await readWorkerScorecardV1(async () => Response.json({ groups: [] }));
  assert.deepEqual(invalid, { state: "unavailable" });
  const badKind = await readWorkerScorecardV1(async () => Response.json({ observedAt: "2026-09-29T12:00:00.000Z",
    groups: [{ workerKind: "not-a-worker", model: "sol", effort: "high", provider: null, profile: null,
      last7Days: { finished: 0, passedFirstTime: 0, neededFixes: 0, failedOrBlocked: 0, caughtBy: [] },
      last30Days: { finished: 0, passedFirstTime: 0, neededFixes: 0, failedOrBlocked: 0, caughtBy: [] } }] }));
  assert.deepEqual(badKind, { state: "unavailable" });
});

function row(overrides: Partial<{ worker_kind: string; model: string; effort: string; provider: string | null; profile: string | null;
  state: string; finished_at: string; revision_number: string | null; catcher_reviewer: unknown }>) {
  return { worker_kind: "codex", model: "sol", effort: "high", provider: null, profile: null,
    state: "succeeded", finished_at: "2026-09-29T10:00:00.000Z", revision_number: "0", catcher_reviewer: null, ...overrides };
}

test("the scorecard read is tenant-bound, scoped to build/builder stages, and buckets pass/fix/block correctly", async () => {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const rows = [
    row({}), // passed first time
    row({ revision_number: "2", catcher_reviewer: { actorType: "agent", harness: "claude" } }), // needed fixes, caught by Claude
    row({ state: "failed", revision_number: null }), // failed
    row({ state: "cancelled", revision_number: null, finished_at: "2026-09-01T10:00:00.000Z" }), // outside the 7-day window but inside 30
  ];
  const db = { query: async <T,>(sql: string, values: unknown[]) => { calls.push({ sql, values }); return { rows: rows as T[] }; } };
  const result = await new DatabaseWorkerScorecardReadSourceV1(db as never)
    .read({ tenantId: "tenant:one", now: "2026-09-29T12:00:00.000Z" });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]?.values[0], "tenant:one");
  assert.match(calls[0]?.sql ?? "", /stage_kind='build' AND role='builder'/);
  assert.match(calls[0]?.sql ?? "", /tenant_id=\$1/);
  assert.equal(result.groups.length, 1);
  const [only] = result.groups;
  assert.equal(only?.last7Days.finished, 3); assert.equal(only?.last7Days.passedFirstTime, 1);
  assert.equal(only?.last7Days.neededFixes, 1); assert.equal(only?.last7Days.failedOrBlocked, 1);
  assert.deepEqual(only?.last7Days.caughtBy, [{ label: "Claude checker", count: 1 }]);
  assert.equal(only?.last30Days.finished, 4); assert.equal(only?.last30Days.failedOrBlocked, 2);
});

test("an unrecognised worker kind or effort in a row fails closed rather than being silently dropped or mislabeled", async () => {
  const db = { query: async <T,>() => ({ rows: [row({ worker_kind: "unknown-kind" })] as T[] }) };
  await assert.rejects(new DatabaseWorkerScorecardReadSourceV1(db as never).read({ tenantId: "tenant:one", now: "2026-09-29T12:00:00.000Z" }),
    /invalid_worker_scorecard_record/);
});

test("an invalid scope is rejected before any query runs", async () => {
  const db = { query: async () => { throw new Error("must not query"); } };
  await assert.rejects(new DatabaseWorkerScorecardReadSourceV1(db as never).read({ tenantId: "", now: "2026-09-29T12:00:00.000Z" }),
    /invalid_worker_scorecard_scope/);
});

/** Mount the real panel against a minimal fetch mock and let its effect settle. */
async function mountScorecard(response: Response) {
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
  globalThis.fetch = (async () => response) as typeof fetch;
  const root = createRoot(dom.window.document.getElementById("root")!);
  await React.act(async () => { root.render(React.createElement(WorkersScorecard)); });
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await React.act(async () => { await new Promise(resolve => dom.window.setTimeout(resolve, 5)); });
    if (!/Loading saved scorecard/.test(dom.window.document.body.textContent ?? "")) break;
  }
  const restore = async () => {
    try { await React.act(async () => { root.unmount(); }); } catch { /* already torn down */ }
    dom.window.close();
    for (const [key, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  };
  return { text: () => dom.window.document.body.textContent ?? "", restore };
}

test("the scorecard panel shows a plain empty state when nothing has finished, with no count pill", async () => {
  const mounted = await mountScorecard(Response.json({ observedAt: "2026-09-29T12:00:00.000Z", groups: [] }));
  try {
    assert.match(mounted.text(), /No pipeline build stage has finished yet\./);
    assert.doesNotMatch(mounted.text(), /private-count/);
  } finally { await mounted.restore(); }
});

test("the scorecard panel reports unavailable rather than an empty board when the read fails", async () => {
  const mounted = await mountScorecard(new Response(null, { status: 500 }));
  try { assert.match(mounted.text(), /The scorecard could not be read\. No pass rate or count is inferred\./); }
  finally { await mounted.restore(); }
});

test("the scorecard panel renders a real group with its count", async () => {
  const mounted = await mountScorecard(Response.json({ observedAt: "2026-09-29T12:00:00.000Z", groups: [group] }));
  try { assert.match(mounted.text(), /Codex — sol\/high/); assert.match(mounted.text(), /3 finished/); }
  finally { await mounted.restore(); }
});
