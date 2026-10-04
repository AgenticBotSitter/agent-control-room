import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ScorecardGroupRow, WorkersScorecard } from "../private-app/app/workers/workers-scorecard";
import { readWorkerScorecardV1, type WorkerScorecardReadV1 } from "../src/web/v1/worker-scorecard-browser-client";
import { DatabaseWorkerScorecardReadSourceV1 } from "../src/web/v1/worker-scorecard-read";

const group: WorkerScorecardReadV1["groups"][number] = { workerKind: "codex", model: "sol", effort: "high",
  provider: null, profile: null,
  last7Days: { finished: 3, passedFirstTime: 2, neededFixes: 1, failedOrBlocked: 0, unknownReview: 0, caughtBy: [{ label: "Claude checker", count: 1 }] },
  last30Days: { finished: 3, passedFirstTime: 2, neededFixes: 1, failedOrBlocked: 0, unknownReview: 0, caughtBy: [{ label: "Claude checker", count: 1 }] } };

test("a scorecard row names the worker and model and reports pass/fix/block counts without inventing a rate", () => {
  const html = renderToStaticMarkup(createElement(ScorecardGroupRow, { group }));
  assert.match(html, /Codex — sol\/high/);
  assert.match(html, /3 finished/); assert.match(html, /2 passed first time/);
  assert.match(html, /1 needed fixes/); assert.match(html, /0 failed or blocked/);
  assert.match(html, /caught by Claude checker \(1\)/);
});

test("a window with nothing finished says so instead of showing zeroes", () => {
  const empty: WorkerScorecardReadV1["groups"][number] = { ...group,
    last7Days: { finished: 0, passedFirstTime: 0, neededFixes: 0, failedOrBlocked: 0, unknownReview: 0, caughtBy: [] } };
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
      last7Days: { finished: 0, passedFirstTime: 0, neededFixes: 0, failedOrBlocked: 0, unknownReview: 0, caughtBy: [] },
      last30Days: { finished: 0, passedFirstTime: 0, neededFixes: 0, failedOrBlocked: 0, unknownReview: 0, caughtBy: [] } }] }));
  assert.deepEqual(badKind, { state: "unavailable" });
});

/** One already-grouped row, as the aggregate query returns it: bigint counts as
 * decimal strings, and reviewer pairs as `{ "actorType/harness": count }`. */
function grouped(overrides: Partial<Record<string, unknown>> = {}) {
  return { worker_kind: "codex", model: "sol", effort: "high", provider: null, profile: null,
    finished_30: "4", passed_first_time_30: "1", needed_fixes_30: "1", failed_or_blocked_30: "2", unknown_review_30: "0",
    finished_7: "3", passed_first_time_7: "1", needed_fixes_7: "1", failed_or_blocked_7: "1", unknown_review_7: "0",
    catcher_pairs_7: { "agent/claude": "1" }, catcher_pairs_30: { "agent/claude": "1" }, ...overrides };
}

test("the scorecard read is tenant-bound, closed on both window ends, and maps grouped counts and reviewer labels", async () => {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const db = { query: async <T,>(sql: string, values: unknown[]) => {
    calls.push({ sql, values }); return { rows: [grouped()] as T[] };
  } };
  const result = await new DatabaseWorkerScorecardReadSourceV1(db as never)
    .read({ tenantId: "tenant:one", workspaceId: "workspace:one", now: "2026-09-29T12:00:00.000Z" });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]?.values[0], "tenant:one");
  assert.match(calls[0]?.sql ?? "", /s\.stage_kind='build' AND s\.role='builder'/);
  assert.match(calls[0]?.sql ?? "", /tenant_id=\$1/);
  // Workspace scope is applied in SQL, through projects.workspace_id, not by a
  // caller filtering a returned view: a filtered read has already held the other
  // workspace's rows.
  assert.match(calls[0]?.sql ?? "", /JOIN projects p ON p\.tenant_id=s\.tenant_id AND p\.id=s\.project_id AND p\.workspace_id=\$5/);
  assert.equal(calls[0]?.values[4], "workspace:one", "the workspace is a bound parameter, never interpolated");
  // The window is closed on both sides: an upper bound at the captured instant
  // is what keeps a future-dated finish out of "last 7/30 days".
  assert.match(calls[0]?.sql ?? "", /s\.finished_at>=\$2::timestamptz AND s\.finished_at<=\$3::timestamptz/);
  assert.equal(calls[0]?.values[1], "2026-08-30T12:00:00.000Z", "30-day lower bound");
  assert.equal(calls[0]?.values[2], "2026-09-29T12:00:00.000Z", "the captured instant is the upper bound");
  assert.equal(calls[0]?.values[3], "2026-09-22T12:00:00.000Z", "7-day lower bound");
  // The counting is done by the database, not by a capped row scan: a row cap
  // silently drops an older model once a busier one fills it.
  assert.match(calls[0]?.sql ?? "", /GROUP BY worker_kind,model,effort,provider,profile/);
  assert.doesNotMatch(calls[0]?.sql ?? "", /LIMIT 2000/u);
  assert.equal(result.groups.length, 1);
  const [only] = result.groups;
  assert.equal(only?.last7Days.finished, 3); assert.equal(only?.last7Days.passedFirstTime, 1);
  assert.equal(only?.last7Days.neededFixes, 1); assert.equal(only?.last7Days.failedOrBlocked, 1);
  assert.deepEqual(only?.last7Days.caughtBy, [{ label: "Claude checker", count: 1 }]);
  assert.equal(only?.last30Days.finished, 4); assert.equal(only?.last30Days.failedOrBlocked, 2);
});

test("reviewer pairs are labelled the same way whether SQL counted one or several", async () => {
  const read = async (pairs: unknown) => {
    const db = { query: async <T,>() => ({ rows: [grouped({ catcher_pairs_30: pairs, catcher_pairs_7: null })] as T[] }) };
    const result = await new DatabaseWorkerScorecardReadSourceV1(db as never)
      .read({ tenantId: "tenant:one", workspaceId: "workspace:one", now: "2026-09-29T12:00:00.000Z" });
    return result.groups[0]!.last30Days.caughtBy;
  };
  // A human and an agent with no harness both land on plain labels, and
  // nothing is folded into "Owner".
  assert.deepEqual(await read({ "human/none": "2", "agent/none": "1" }),
    [{ label: "Owner", count: 2 }, { label: "Agent checker", count: 1 }]);
  assert.deepEqual(await read({ "service/none": "1" }), [{ label: "Automated check", count: 1 }]);
  // Two unknown harnesses that map to the same label are added, not listed
  // twice. A KNOWN harness keeps its own label, so the grouping does not lose
  // the distinction the owner reads.
  assert.deepEqual(await read({ "agent/other": "2", "agent/unknown": "1" }),
    [{ label: "Agent checker", count: 3 }]);
  assert.deepEqual(await read({ "agent/hermes": "1", "agent/other": "2" }),
    [{ label: "Agent checker", count: 2 }, { label: "Hermes checker", count: 1 }]);
  // A null map (no reviewed fixes at all) is an empty list, not a throw.
  assert.deepEqual(await read(null), []);
});

test("the 30-day catcher map totals its own window rather than only the rows outside seven days", async () => {
  // A 7-day fix is ALSO a 30-day fix. Deriving the 30-day map as "the rows
  // outside seven days" made it EMPTY for any group whose fixes were all
  // recent - found on real PostgreSQL, where "Claude checker" appeared under
  // Last 7 days and nothing under Last 30 days. Both maps are read as supplied
  // and neither is derived from the other.
  const db = { query: async <T,>() => ({ rows: [grouped({
    catcher_pairs_7: { "agent/claude": "1" }, catcher_pairs_30: { "agent/claude": "1" } })] as T[] }) };
  const result = await new DatabaseWorkerScorecardReadSourceV1(db as never)
    .read({ tenantId: "tenant:one", workspaceId: "workspace:one", now: "2026-09-29T12:00:00.000Z" });
  const group = result.groups[0]!;
  assert.deepEqual(group.last7Days.caughtBy, [{ label: "Claude checker", count: 1 }]);
  assert.deepEqual(group.last30Days.caughtBy, [{ label: "Claude checker", count: 1 }],
    "a fix inside seven days is inside thirty days too");
  // A group with fixes spread either side of the boundary reports both totals
  // without double-counting the recent one.
  const spread = { query: async <T,>() => ({ rows: [grouped({
    catcher_pairs_7: { "agent/claude": "1" }, catcher_pairs_30: { "agent/claude": "1", "human/none": "2" } })] as T[] }) };
  const spreadResult = await new DatabaseWorkerScorecardReadSourceV1(spread as never)
    .read({ tenantId: "tenant:one", workspaceId: "workspace:one", now: "2026-09-29T12:00:00.000Z" });
  assert.deepEqual(spreadResult.groups[0]!.last30Days.caughtBy,
    [{ label: "Owner", count: 2 }, { label: "Claude checker", count: 1 }]);
  assert.deepEqual(spreadResult.groups[0]!.last7Days.caughtBy, [{ label: "Claude checker", count: 1 }]);
});

test("a count that is not a non-negative integer fails closed rather than reaching the wire", async () => {
  for (const bad of ["-1", "1.5", "", "9007199254740993", "NaN"]) {
    const db = { query: async <T,>() => ({ rows: [grouped({ finished_7: bad })] as T[] }) };
    await assert.rejects(new DatabaseWorkerScorecardReadSourceV1(db as never)
      .read({ tenantId: "tenant:one", workspaceId: "workspace:one", now: "2026-09-29T12:00:00.000Z" }),
    /invalid_worker_scorecard_record/u, `${bad} must not be presented as a count`);
  }
});

test("an unrecognised worker kind or effort in a row fails closed rather than being silently dropped or mislabeled", async () => {
  for (const bad of [{ worker_kind: "unknown-kind" }, { effort: "turbo" }]) {
    const db = { query: async <T,>() => ({ rows: [grouped(bad)] as T[] }) };
    await assert.rejects(new DatabaseWorkerScorecardReadSourceV1(db as never).read({ tenantId: "tenant:one", workspaceId: "workspace:one", now: "2026-09-29T12:00:00.000Z" }),
      /invalid_worker_scorecard_record/);
  }
});

test("an invalid scope is rejected before any query runs", async () => {
  const db = { query: async () => { throw new Error("must not query"); } };
  const read = new DatabaseWorkerScorecardReadSourceV1(db as never);
  await assert.rejects(read.read({ tenantId: "", workspaceId: "workspace:one", now: "2026-09-29T12:00:00.000Z" }),
    /invalid_worker_scorecard_scope/);
  // A missing or malformed workspace is refused on the same terms as a
  // malformed tenant, and before any query runs: the scope is applied in SQL,
  // so a blank one would otherwise mean "no workspace matches" as a silent
  // empty board rather than a refusal.
  await assert.rejects(read.read({ tenantId: "tenant:one", workspaceId: "", now: "2026-09-29T12:00:00.000Z" }),
    /invalid_worker_scorecard_scope/);
  await assert.rejects(read.read({ tenantId: "tenant:one", workspaceId: "workspace:one", now: "not-a-time" }),
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


test("M3-SCORE-02: 201 groups retain the newest 200 and explicitly display older omissions", async () => {
  const rows = Array.from({ length: 201 }, (_, i) => grouped({ model: `model-${String(i).padStart(3, "0")}` }));
  // The SQL returns newest first; alphabetic order deliberately differs.
  rows.reverse();
  const source = new DatabaseWorkerScorecardReadSourceV1({ query: async () => ({ rows }) } as never);
  const result = await source.read({ tenantId: "tenant:one", workspaceId: "workspace:one", now: "2026-09-29T12:00:00.000Z" });
  assert.equal(result.groups.length, 200);
  assert.equal((result as { olderGroupsOmitted?: number }).olderGroupsOmitted, 1);
  assert.equal(result.groups.some(item => item.model === "model-000"), false);
  assert.equal(result.groups.some(item => item.model === "model-200"), true);
  const reads = await Promise.all(Array.from({ length: 50 }, () => readWorkerScorecardV1(async () => Response.json(result))));
  assert.ok(reads.every(read => read.state === "available"));
  const mounted = await mountScorecard(Response.json(result));
  try { assert.match(mounted.text(), /1 older groups not shown/); assert.match(mounted.text(), /model-200/); }
  finally { await mounted.restore(); }
  const control = await new DatabaseWorkerScorecardReadSourceV1({ query: async () => ({ rows: rows.slice(0, 200) }) } as never)
    .read({ tenantId: "tenant:one", workspaceId: "workspace:one", now: "2026-09-29T12:00:00.000Z" });
  assert.equal((control as { olderGroupsOmitted?: number }).olderGroupsOmitted, 0);
});

test("M3-SCORE-03: missing review evidence is counted and displayed as unknown", async () => {
  const source = new DatabaseWorkerScorecardReadSourceV1({ query: async () => ({ rows: [grouped({
    finished_30: "1", passed_first_time_30: "0", needed_fixes_30: "0", failed_or_blocked_30: "0", unknown_review_30: "1",
    finished_7: "1", passed_first_time_7: "0", needed_fixes_7: "0", failed_or_blocked_7: "0", unknown_review_7: "1",
    catcher_pairs_7: null, catcher_pairs_30: null })] }) } as never);
  const result = await source.read({ tenantId: "tenant:one", workspaceId: "workspace:one", now: "2026-09-29T12:00:00.000Z" });
  const read = await readWorkerScorecardV1(async () => Response.json(result));
  assert.equal(read.state, "available");
  for (const bucket of [result.groups[0]!.last7Days, result.groups[0]!.last30Days]) {
    assert.equal((bucket as { unknownReview?: number }).unknownReview, 1);
    assert.equal(bucket.finished, bucket.passedFirstTime + bucket.neededFixes + bucket.failedOrBlocked +
      (bucket as { unknownReview: number }).unknownReview);
  }
  const html = renderToStaticMarkup(createElement(ScorecardGroupRow, { group: result.groups[0]! }));
  assert.match(html, /1 review outcome unknown/);
});

test("M3-SCORE-02 and M3-SCORE-03: omission and unknown counts refuse malformed wire values", async () => {
  const { workerScorecardReadSchemaV1 } = await import("../src/web/v1/worker-scorecard-browser-client");
  const view = { observedAt: "2026-10-01T00:00:00.000Z", groups: [group], olderGroupsOmitted: 1 };
  for (const value of [-1, 0.5, "1", null]) {
    assert.equal(workerScorecardReadSchemaV1.safeParse({ ...view, olderGroupsOmitted: value }).success, false);
    assert.equal(workerScorecardReadSchemaV1.safeParse({ ...view, groups: [{ ...group,
      last7Days: { ...group.last7Days, unknownReview: value } }] }).success, false);
  }
});
