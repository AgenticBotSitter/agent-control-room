import assert from "node:assert/strict";
import { test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { NewsResearchForm } from "../private-app/app/news-research-form.tsx";

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
