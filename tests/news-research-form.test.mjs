import assert from "node:assert/strict";
import { test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { NewsResearchForm } from "../private-app/app/news-research-form.tsx";
import { fixture, now, trust, request } from "./helpers/web-foundation";
import { createAccessVerifier } from "../src/web/v1/access-verifier";
import { AbsControlCenterIngestion } from "../src/project-adapters/news/v1/control-center-ingestion";
import { PostgresNewsStoreV1 } from "../src/project-adapters/news/v1/postgres-store";

test("research draft response cannot cross a project or story-version change", async () => {
  const dom = new JSDOM("<div id='root'></div>", { url: "https://example.invalid/projects/project:one/news" });
  const saved = Object.fromEntries(["window", "document", "IS_REACT_ACT_ENVIRONMENT", "fetch"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const pending = [];
  globalThis.fetch = (url, options) => new Promise(resolve => pending.push({ url, options, resolve }));
  const root = createRoot(dom.window.document.getElementById("root"));
  const story = { storyId: "story:fixture", storyDigest: `sha256:${"a".repeat(64)}`, title: "Synthetic story",
    summary: "Fixture", canonicalUrl: "https://example.invalid/article", queue: "important_now", verificationState: "verified" };
  const props = { projectId: "project:one", story, close: () => {} };
  const render = value => act(async () => root.render(React.createElement(NewsResearchForm, value)));
  const submit = () => act(async () => dom.window.document.querySelector("form").dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })));
  const preview = (projectId, digest, instructions) => ({ projectId, storyId: story.storyId, storyDigest: digest,
    draft: { title: "Synthetic research", instructions }, saved: false, dispatch: "not_requested" });
  try {
    await render(props); await submit();
    assert.equal(pending.length, 1);
    await render({ ...props, projectId: "project:two" });
    await act(async () => pending[0].resolve(Response.json(preview(props.projectId, story.storyDigest, "OLD PROJECT CONTENT"))));
    assert.doesNotMatch(dom.window.document.body.textContent, /OLD PROJECT CONTENT/);
    assert.equal(pending[0].options.signal.aborted, true);
    await submit();
    const nextStory = { ...story, storyDigest: `sha256:${"b".repeat(64)}` };
    await render({ ...props, projectId: "project:two", story: nextStory });
    await act(async () => pending[1].resolve(Response.json(preview("project:two", story.storyDigest, "OLD STORY VERSION"))));
    assert.doesNotMatch(dom.window.document.body.textContent, /OLD STORY VERSION/);
    await submit();
    await act(async () => pending[2].resolve(Response.json(preview("project:two", nextStory.storyDigest, "Current research instructions"))));
    assert.match(dom.window.document.body.textContent, /Current research instructions/);
    const save = [...dom.window.document.querySelectorAll("button")].find(button => button.textContent === "Save proposed task");
    await act(async () => save.click());
    assert.match(pending[3].url, /projects\/project%3Atwo\/tasks$/);
    assert.equal(JSON.parse(pending[3].options.body).instructions, "Current research instructions");
    await act(async () => pending[3].resolve(Response.json({ receipt: { projectId: "project:two", jobId: "job:fixture",
      requestId: "request:fixture", createdAt: "2026-09-09T00:00:00.000Z", submission: "proposed", startsWork: false }, replayed: false })));
    assert.match(dom.window.document.body.textContent, /Task saved for review. No bot has been started/);
  } finally {
    await act(async () => root.unmount()); dom.window.close();
    for (const [key, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    }
  }
});

test("project switch preserves an uncertain save client and retries only its original command", async () => {
  const dom = new JSDOM("<div id='root'></div>", { url: "https://example.invalid/" });
  const saved = Object.fromEntries(["window", "document", "IS_REACT_ACT_ENVIRONMENT", "fetch"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const pending = [];
  globalThis.fetch = (url, options) => new Promise(resolve => pending.push({ url, options, resolve }));
  const root = createRoot(dom.window.document.getElementById("root"));
  const story = { storyId: "story:fixture", storyDigest: `sha256:${"a".repeat(64)}`, title: "First story",
    summary: "Fixture", canonicalUrl: "https://example.invalid/article", queue: "important_now", verificationState: "verified" };
  const props = { projectId: "project:one", story, close: () => {} };
  const button = text => [...dom.window.document.querySelectorAll("button")].find(value => value.textContent === text);
  try {
    await act(async () => root.render(React.createElement(NewsResearchForm, props)));
    await act(async () => dom.window.document.querySelector("form").dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })));
    await act(async () => pending[0].resolve(Response.json({ projectId: props.projectId, storyId: story.storyId,
      storyDigest: story.storyDigest, draft: { title: "First research", instructions: "ORIGINAL PRIVATE DRAFT" }, saved: false, dispatch: "not_requested" })));
    await act(async () => button("Save proposed task").click());
    await act(async () => root.render(React.createElement(NewsResearchForm, { ...props, projectId: "project:two", story: { ...story, title: "Second story" } })));
    assert.doesNotMatch(dom.window.document.body.textContent, /ORIGINAL PRIVATE DRAFT/);
    assert.equal(dom.window.document.querySelector("form"), null);
    await act(async () => pending[1].resolve(new Response("", { status: 500 })));
    assert.match(dom.window.document.body.textContent, /Resolve that exact save/);
    await act(async () => button("Check earlier save again").click());
    assert.equal(pending[2].url, pending[1].url);
    assert.equal(pending[2].options.body, pending[1].options.body);
    assert.equal(pending[2].options.headers["idempotency-key"], pending[1].options.headers["idempotency-key"]);
    await act(async () => pending[2].resolve(Response.json({ receipt: { projectId: props.projectId, jobId: "job:fixture",
      requestId: "request:fixture", createdAt: "2026-09-09T00:00:00.000Z", submission: "proposed", startsWork: false }, replayed: true })));
    assert.match(dom.window.document.body.textContent, /Second story/);
    assert.ok(dom.window.document.querySelector("form"));
    assert.doesNotMatch(dom.window.document.body.textContent, /ORIGINAL PRIVATE DRAFT/);
    assert.equal(pending.length, 3);
  } finally {
    await act(async () => root.unmount()); dom.window.close();
    for (const [key, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    }
  }
});

const DISCOVERY_SOURCE = { id: "source:discovery-fixture", name: "Discovery fixture", url: "https://example.invalid/feed" };

async function discoverySetup(t, keySuffix) {
  const f = await fixture(); t.after(() => f.db.close());
  const identity = createAccessVerifier(trust)(request(), now);
  const { project } = await f.service.create(identity, { title: `Discovery fixture ${keySuffix}`, summary: "Synthetic" },
    `discovery-fixture-${keySuffix}`);
  const scope = { tenantId: "tenant:web", workspaceId: "workspace:web", projectId: project.projectId };
  const key = new Uint8Array(32).fill(6);
  const ingest = new AbsControlCenterIngestion(f.client, { ...scope, source: DISCOVERY_SOURCE }, key);
  const checkedAt = new Date(now).toISOString();
  const items = [
    { title: "First industry discovery", summary: "First synthetic industry summary",
      url: "https://example.invalid/articles/one", publishedAt: new Date(now - 3600_000).toISOString() },
    { title: "Second industry discovery", summary: "Second synthetic industry summary",
      url: "https://example.invalid/articles/two", publishedAt: new Date(now - 7200_000).toISOString() },
  ];
  const result = (overrides = {}) => ({ sourceUrl: DISCOVERY_SOURCE.url, coverageComplete: true, feedKind: "rss",
    snapshot: { sourceUrl: DISCOVERY_SOURCE.url, endpoint: DISCOVERY_SOURCE.url, checkedAt, mode: "feed",
      urls: { "https://example.invalid/articles/one": checkedAt, "https://example.invalid/articles/two": checkedAt } },
    status: { sourceId: DISCOVERY_SOURCE.id, source: DISCOVERY_SOURCE.name, mode: "feed", endpoint: DISCOVERY_SOURCE.url },
    items, ...overrides });
  const reader = { readSource: async () => result() };
  const store = new PostgresNewsStoreV1(f.client, scope, key);
  const storyCount = async () => Number((await f.client.query(
    "SELECT count(*)::text AS count FROM control_news_story_versions WHERE tenant_id=$1 AND workspace_id=$2 AND project_id=$3",
    [scope.tenantId, scope.workspaceId, scope.projectId])).rows[0].count);
  const baselineCount = async () => Number((await f.client.query(
    "SELECT count(*)::text AS count FROM control_news_discovery_baselines WHERE tenant_id=$1 AND workspace_id=$2 AND project_id=$3",
    [scope.tenantId, scope.workspaceId, scope.projectId])).rows[0].count);
  return { ingest, store, checkedAt, items, result, reader, storyCount, baselineCount, clock: () => now };
}

test("control-center ingestion persists two discovered stories readable from the news store", async t => {
  const s = await discoverySetup(t, "happy-path");
  const outcome = await s.ingest.collect(s.reader, new AbortController().signal, s.clock);
  assert.equal(outcome.inserted, 2);
  assert.equal(outcome.rejectedCount, 0);
  assert.equal(outcome.duplicateCount, 0);
  const { stories } = await s.store.listStories(undefined, { view: "all", observedAt: s.checkedAt });
  assert.equal(stories.length, 2);
  const byUrl = new Map(stories.map(story => [story.canonicalUrl, story]));
  for (const item of s.items) {
    const story = byUrl.get(item.url);
    assert.ok(story, `expected a persisted story for ${item.url}`);
    assert.equal(story.title, item.title);
    assert.equal(story.sourceEvidence[0].sourceKind, "rss");
    assert.equal(story.sourceEvidence[0].sourceId, DISCOVERY_SOURCE.id);
    assert.equal(story.sourceEvidence[0].sourceLabel, DISCOVERY_SOURCE.name);
  }
  assert.deepEqual(await s.ingest.loadBaseline(), s.result().snapshot);
});

test("control-center ingestion replays an identical reader result without writing new rows", async t => {
  const s = await discoverySetup(t, "baseline-replay");
  const first = await s.ingest.collect(s.reader, new AbortController().signal, s.clock);
  assert.equal(first.inserted, 2);
  assert.equal(await s.storyCount(), 2);
  assert.equal(await s.baselineCount(), 1);
  const second = await s.ingest.collect(s.reader, new AbortController().signal, s.clock);
  assert.equal(second.inserted, 0);
  assert.equal(second.replayed, 2);
  assert.equal(second.rejectedCount, 0);
  assert.equal(await s.storyCount(), 2);
  assert.equal(await s.baselineCount(), 1);
  assert.deepEqual(await s.ingest.loadBaseline(), s.result().snapshot);
});

test("control-center ingestion throws news_source_mismatch for a mismatched status", async t => {
  const s = await discoverySetup(t, "source-mismatch");
  const mismatched = s.result();
  mismatched.status = { ...mismatched.status, sourceId: "source:other-source" };
  const reader = { readSource: async () => mismatched };
  await assert.rejects(s.ingest.collect(reader, new AbortController().signal, s.clock), /news_source_mismatch/);
  assert.equal(await s.storyCount(), 0);
  assert.equal(await s.ingest.loadBaseline(), undefined);
});

test("control-center ingestion rejects a future-dated item individually without failing the batch", async t => {
  const s = await discoverySetup(t, "future-item");
  const reader = { readSource: async () => s.result({ items: [
    { title: "Future industry discovery", summary: "Synthetic future-dated item",
      url: "https://example.invalid/articles/future", publishedAt: new Date(now + 3600_000).toISOString() },
    s.items[1],
  ] }) };
  const outcome = await s.ingest.collect(reader, new AbortController().signal, s.clock);
  assert.equal(outcome.rejectedCount, 1);
  assert.equal(outcome.inserted, 1);
  const { stories } = await s.store.listStories(undefined, { view: "all", observedAt: s.checkedAt });
  assert.equal(stories.length, 1);
  assert.equal(stories[0].canonicalUrl, "https://example.invalid/articles/two");
  assert.equal(outcome.status.state, "partial");
  // A batch with a rejected item must not advance restart memory.
  assert.equal(await s.ingest.loadBaseline(), undefined);
});

test("control-center ingestion aborts before any persistence when the signal is already aborted", async t => {
  const s = await discoverySetup(t, "aborted-signal");
  const controller = new AbortController(); controller.abort();
  await assert.rejects(s.ingest.collect(s.reader, controller.signal, s.clock), { name: "AbortError" });
  assert.equal(await s.storyCount(), 0);
  assert.equal(await s.ingest.loadBaseline(), undefined);
});
