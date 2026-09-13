import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Home from "../private-app/app/page";
import { HomeDashboard, type HomeDashboardState } from "../private-app/app/home-workspace";
import SettingsPage from "../private-app/app/settings/page";
import { readTaskHomeActivity } from "../src/web/v1/task-home-browser-client";

test("home gives honest navigation to existing private workspace surfaces", () => {
  const html = renderToStaticMarkup(createElement(Home));
  for (const href of ["/projects", "/workers", "/needs-me", "/settings"]) assert.match(html, new RegExp(`href="${href}"`));
  assert.doesNotMatch(html, /href="\/ideas"/);
  assert.match(html, /aria-controls="private-workspace-navigation"/);
  assert.match(html, /<nav id="private-workspace-navigation" class="private-navigation"/);
  assert.doesNotMatch(html, /<details/);
  assert.match(html, /Each section reports unavailable data instead of replacing it with a zero/);
  assert.doesNotMatch(html, /Idea Lab is optional/);
  assert.doesNotMatch(html, /live workers|running now|0 tasks/i);
  for (const label of ["Loading saved work", "Loading saved attention items", "Loading verified result records",
    "Loading saved worker signals", "Loading saved projects"]) assert.match(html, new RegExp(label));
});

test("home dashboard links exact saved work, results, attention and projects without starting anything", () => {
  const task = { jobId: "job:running", projectId: "project:alpha", requestId: "request:alpha", title: "Prepare report",
    state: "running" as const, version: 2, createdAt: "2026-09-04T10:00:00.000Z", updatedAt: "2026-09-04T12:00:00.000Z" };
  const data = { activity: { state: "ready", value: { active: [task], recentResults: [{ task: { ...task, jobId: "job:done",
    requestId: "request:done", title: "Completed research", state: "succeeded" }, artifact: { artifactId: "artifact:result",
    attemptId: "attempt:done", runId: "run:done", contentHash: `sha256:${"a".repeat(64)}`, sizeBytes: 42,
    receivedAt: "2026-09-04T12:00:00.000Z", byteCheck: "matched_recorded_claim", qualityAccepted: false } }],
    additionalActiveOmitted: false, additionalResultsOmitted: false, resultSource: "configured", observedAt: "2026-09-04T12:00:00.000Z",
    startsWork: false } }, attention: { state: "ready", value: { items: [{ task, inputDigest: `sha256:${"b".repeat(64)}`,
    reasons: ["approval"] }], nextCursor: null, examined: 1, observedAt: "2026-09-04T12:00:00.000Z", startsWork: false,
    planningSource: "configured", deliverySource: "configured", sources: { ordinary: "included", ideas: "not_configured" } } },
    projects: { state: "ready", value: { projects: [{ projectId: "project:alpha", title: "Alpha", summary: "Project",
      lifecycle: "active", version: 1, createdAt: "2026-09-04T10:00:00.000Z", updatedAt: "2026-09-04T12:00:00.000Z",
      origin: "ordinary", lifecycleEditable: true }], nextCursor: null, canCreate: true,
      sources: { ordinary: "included", ideas: "not_configured" } } }, connections: { state: "ready", value: { telemetry: "configured",
      projection: { summary: { connectionCount: 2, currentSignalCount: 1, staleSignalCount: 1, missingSignalCount: 0,
        attentionCount: 1 } } } } } as unknown as HomeDashboardState;
  const html = renderToStaticMarkup(createElement(HomeDashboard, { data }));
  assert.match(html, /Prepare report/); assert.match(html, /Completed research/); assert.match(html, /Alpha/);
  assert.match(html, /2 enrolled workers/); assert.match(html, /approval/);
  assert.match(html, /projects\/project%3Aalpha\/tasks\/job%3Arunning/);
  assert.doesNotMatch(html, /submit|retry|resume|start agent/i);
});

test("home dashboard keeps independent unavailable sources explicit", () => {
  const unavailable = { state: "unavailable" } as const;
  const html = renderToStaticMarkup(createElement(HomeDashboard, { data: { projects: unavailable, activity: unavailable,
    attention: unavailable, connections: unavailable } }));
  for (const label of ["Running work is unavailable", "Attention items are unavailable",
    "Verified result records are unavailable", "Worker status is unavailable", "Projects are unavailable"])
    assert.match(html, new RegExp(label));
  assert.doesNotMatch(html, />0</);
});

test("home task reader accepts only the bounded read-only activity contract", async () => {
  let requested = ""; let method = "";
  const transport = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requested = String(input); method = init?.method ?? "";
    return Response.json({ active: [], recentResults: [], additionalActiveOmitted: false,
      additionalResultsOmitted: false, resultSource: "not_configured", observedAt: "2026-09-04T12:00:00.000Z", startsWork: false });
  }) as typeof fetch;
  const result = await readTaskHomeActivity(transport);
  assert.equal(requested, "/api/v1/home/tasks"); assert.equal(method, "GET"); assert.equal(result.startsWork, false);
  await assert.rejects(readTaskHomeActivity((async () => Response.json({ ...result, startsWork: true })) as typeof fetch), /unavailable/);
  await assert.rejects(readTaskHomeActivity((async () => Response.json({ ...result, resultSource: "not_authorized",
    recentResults: [{ unexpected: true }] })) as typeof fetch), /unavailable/);
});

test("settings links to the real session surface without credential controls", () => {
  const html = renderToStaticMarkup(createElement(SettingsPage));
  assert.match(html, /href="\/session"/);
  assert.match(html, /does not expose credentials/);
  assert.doesNotMatch(html, /password|api key|secret key/i);
});
