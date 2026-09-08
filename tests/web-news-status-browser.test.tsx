import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { createNewsRefreshClient, type NewsRefreshDescription } from "../src/web/v1/news-refresh-client";
import { createNewsStatusObserver } from "../src/web/v1/news-status-observer";
import { BrowserRequestError } from "../src/web/v1/browser-client";
import type { NewsCollectionStatus } from "../src/web/v1/news-collection-status-wire";
import { NewsCollectionProgress } from "../private-app/app/news-source-refresh";

const time = "2026-09-08T00:00:00.000Z";
const status: NewsCollectionStatus = { projectId: "project:news", sourceId: "source:feed", configured: true, observedAt: time,
  latest: { jobId: "job:collection", jobState: "leased", effectState: "authorized", updatedAt: time, state: "queued" } };
const description: NewsRefreshDescription = { projectId: status.projectId, sourceId: status.sourceId, configured: true,
  canRefresh: true, startsWork: false, sourceDigest: `sha256:${"1".repeat(64)}`, sourceLabel: "Feed", endpointUrl: "https://example.com/feed",
  mode: "feed", sourceCurrent: true, allowedOrigins: ["https://example.com"],
  limits: { timeoutMs: 1000, maxAttempts: 1, maxDocumentBytes: 1000, maxReservedBodyBytes: 1000 } };

test("status reads bind source and exact job without changing uncertain command state", async () => {
  const paths: string[] = [], posts: string[] = [];
  const client = createNewsRefreshClient(status.projectId, status.sourceId, async (path, init) => {
    if (init?.method === "POST") { posts.push(String(init.body)); throw new Error("lost response"); }
    paths.push(String(path)); assert.equal(init?.credentials, "same-origin"); assert.equal(init?.redirect, "error");
    assert.equal(init?.cache, "no-store"); assert.equal(new Headers(init?.headers).get("x-requested-with"), "XMLHttpRequest");
    return Response.json(status);
  });
  await assert.rejects(client.propose(description, "refresh:news-test"));
  const before = client.state();
  assert.deepEqual(await client.status(), status);
  assert.deepEqual(await client.status("job:collection"), status);
  assert.match(paths[0], /\/collection\/status$/); assert.match(paths[1], /\?jobId=job%3Acollection$/);
  assert.equal(client.hasPending(), true); assert.deepEqual(client.state(), before);
  await assert.rejects(client.retry()); assert.equal(posts.length, 2); assert.equal(posts[0], posts[1]);
});

test("status rejects malformed, wrong-scope and wrong-job responses with safe errors", async () => {
  let body: unknown = status, code = 200;
  const client = createNewsRefreshClient(status.projectId, status.sourceId, async () => Response.json(body, { status: code }));
  for (const invalid of [{ ...status, sourceId: "source:other" }, { ...status, projectId: "project:other" },
    { ...status, latest: { ...status.latest, jobId: "job:other" } }, { ...status, latest: null },
    { ...status, latest: { ...status.latest, state: "completed", jobState: "running", effectState: "executing" } },
    { ...status, unexpected: "private-error" }]) {
    body = invalid; await assert.rejects(client.status("job:collection"), /unavailable/);
  }
  body = { ...status, configured: false, latest: null };
  assert.deepEqual(await client.status("job:collection"), body);
  for (const [http, expected] of [[401, "authentication_required"], [403, "access_denied"], [404, "not_found"], [500, "unavailable"]] as const) {
    code = http; await assert.rejects(client.status(), new RegExp(expected));
  }
});

test("status observer is finite, nonoverlapping, hidden-aware and terminal without any command capability", async () => {
  let calls = 0, hidden = false, current = status, release: (() => void) | undefined;
  const controller = createNewsStatusObserver({ read: async () => { calls++; if (release) await new Promise<void>(resolve => { release = resolve; }); return current; },
    accept: () => {}, failed: reason => assert.fail(String(reason)), hidden: () => hidden });
  await controller.read(); hidden = true; await controller.read(true); assert.equal(calls, 1); hidden = false;
  release = () => {}; const waiting = controller.read(true); await controller.read(true); assert.equal(calls, 2);
  release(); await waiting; release = undefined;
  for (let n = 0; n < 200; n++) await controller.read(true);
  assert.equal(calls, 181);
  current = { ...status, latest: { ...status.latest!, state: "completed", jobState: "succeeded", effectState: "confirmed" } };
  await controller.read(); await controller.read(true); assert.equal(calls, 182);
  controller.stop(); await controller.read(); assert.equal(calls, 182);
});

test("status observer pauses on denied access and ignores deferred results after stop", async () => {
  let calls = 0, deny = false, accepted = 0, failures = 0, signal!: AbortSignal, release: (() => void) | undefined;
  const controller = createNewsStatusObserver({ read: async value => { calls++; signal = value;
    if (release) await new Promise<void>(resolve => { release = resolve; });
    if (deny) throw new BrowserRequestError("authentication_required"); return status; },
    accept: () => { accepted++; }, failed: () => { failures++; }, hidden: () => false });
  await controller.read(); deny = true; await controller.read(true); await controller.read(true); assert.equal(calls, 2);
  deny = false; await controller.read(); assert.equal(accepted, 2); assert.equal(failures, 1);
  release = () => {}; const waiting = controller.read(true); controller.stop(); assert.equal(signal.aborted, true);
  release(); await waiting; assert.equal(accepted, 2); assert.equal(failures, 1);
});

test("collection progress renders completion, empty and uncertain honestly with only a news destination", () => {
  const completed = renderToStaticMarkup(<NewsCollectionProgress status={{ ...status,
    latest: { ...status.latest!, state: "completed", jobState: "succeeded", effectState: "confirmed" } }} />);
  assert.match(completed, /Collection completed/); assert.match(completed, /zero new articles/);
  assert.match(completed, /\/projects\/project%3Anews\/news/); assert.doesNotMatch(completed, /\/tasks\//);
  const unknown = renderToStaticMarkup(<NewsCollectionProgress status={{ ...status, latest: { ...status.latest!, state: "uncertain" } }} />);
  assert.match(unknown, /do not repeat/); assert.doesNotMatch(unknown, /Collection completed/);
  assert.match(renderToStaticMarkup(<NewsCollectionProgress status={{ ...status, latest: null }} />), /No retained collection request/);
});

test("command completion retires old status observation before clearing the projection", () => {
  const source = readFileSync("private-app/app/news-source-refresh.tsx", "utf8");
  assert.match(source, /if \(action !== "describe"\) \{ observer\.current\?\.stop\(\); setStatus\(undefined\);/);
  assert.match(source, /observedJob \?\?= value\.latest\?\.jobId/);
});
