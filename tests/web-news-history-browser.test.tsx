import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createNewsRefreshClient } from "../src/web/v1/news-refresh-client";
import type { NewsCollectionHistory } from "../src/web/v1/news-collection-status-wire";
import { NewsCollectionHistoryPage } from "../private-app/app/news-collection-history";

const time = "2026-09-08T00:00:00.000Z";
const empty: NewsCollectionHistory = { projectId: "project:news", sourceId: "source:feed", configured: true,
  observedAt: time, after: null, nextCursor: "job:025", scanned: 25, entries: [] };

test("history traverses more than 100 project records including empty source pages using only scoped GETs", async () => {
  const paths: string[] = [];
  const client = createNewsRefreshClient(empty.projectId, empty.sourceId, async (path, init) => {
    paths.push(String(path)); assert.notEqual(init?.method, "POST"); assert.equal(init?.credentials, "same-origin");
    assert.equal(init?.cache, "no-store"); assert.equal(init?.redirect, "error");
    assert.equal(new Headers(init?.headers).get("x-requested-with"), "XMLHttpRequest");
    const after = new URL(String(path), "https://example.test").searchParams.get("after");
    const offset = after === null ? 0 : Number(after.slice(4));
    const end = offset + 25;
    return Response.json({ ...empty, after, nextCursor: end < 125 ? `job:${String(end).padStart(3, "0")}` : null,
      entries: end === 125 ? [{ jobId: "job:125", createdAt: time }] : [] });
  });
  const before = client.state(); let after: string | undefined, page: NewsCollectionHistory;
  do { page = await client.history(after); after = page.nextCursor ?? undefined; } while (after);
  assert.equal(paths.length, 5); assert.equal(page.entries[0].jobId, "job:125");
  assert.deepEqual(client.state(), before); assert.equal(client.hasPending(), false);
  assert.match(paths[1], /after=job%3A025/);
});

test("history validates scope, cursor echo, ordering, and safe authorization failures", async () => {
  let body: unknown = empty, status = 200;
  const client = createNewsRefreshClient(empty.projectId, empty.sourceId, async () => Response.json(body, { status }));
  for (const invalid of [{ ...empty, projectId: "project:other" }, { ...empty, sourceId: "source:other" },
    { ...empty, after: "job:001" }, { ...empty, entries: [{ jobId: "job:003", createdAt: time }, { jobId: "job:002", createdAt: time }] },
    { ...empty, nextCursor: "job:001", entries: [{ jobId: "job:002", createdAt: time }] },
    { ...empty, private: "untrusted" }]) { body = invalid; await assert.rejects(client.history(), /unavailable/); }
  body = empty; await assert.rejects(client.history("job:025"), /unavailable/);
  status = 401; await assert.rejects(client.history(), /authentication_required/);
  status = 403; await assert.rejects(client.history(), /access_denied/);
});

test("empty filtered page retains Next and page selection controls are disabled during pending work", () => {
  const render = (page: NewsCollectionHistory, disabled: boolean) => renderToStaticMarkup(<NewsCollectionHistoryPage
    page={page} disabled={disabled} choose={() => assert.fail("render must not select")} load={() => assert.fail("render must not read")} />);
  const html = render(empty, false);
  assert.match(html, /No matching refresh/); assert.match(html, /Next history page/); assert.match(html, /not newest-first/);
  const populated = { ...empty, after: "job:001", entries: [{ jobId: "job:010", createdAt: time }] };
  const held = render(populated, true);
  assert.match(held, /First history page/); assert.match(held, /View job:010/);
  assert.equal((held.match(/disabled=""/g) ?? []).length, 3);
});

test("history success and denial preserve an uncertain refresh's exact retry", async () => {
  let deny = false; const bodies: string[] = [];
  const client = createNewsRefreshClient(empty.projectId, empty.sourceId, async (_, init) => {
    if (init?.method === "POST") { bodies.push(String(init.body)); throw new Error("lost response"); }
    return Response.json(empty, { status: deny ? 401 : 200 });
  });
  await assert.rejects(client.propose({ projectId: empty.projectId, sourceId: empty.sourceId, configured: true,
    canRefresh: true, startsWork: false, sourceDigest: `sha256:${"1".repeat(64)}`, sourceLabel: "Feed", endpointUrl: "https://example.com/feed",
    mode: "feed", sourceCurrent: true, allowedOrigins: ["https://example.com"],
    limits: { timeoutMs: 1000, maxAttempts: 1, maxDocumentBytes: 1000, maxReservedBodyBytes: 1000 } }, "refresh:history-test"));
  const before = client.state(); await client.history(); deny = true; await assert.rejects(client.history(), /authentication_required/);
  assert.equal(client.hasPending(), true); assert.deepEqual(client.state(), before);
  await assert.rejects(client.retry()); assert.equal(bodies.length, 2); assert.equal(bodies[0], bodies[1]);
});
