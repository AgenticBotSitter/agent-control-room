import assert from "node:assert/strict";
import { test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { NewsArticleReader } from "../private-app/app/news-article-reader.tsx";

test("article reader shows retained text and discards an old project response", async () => {
  const dom = new JSDOM("<div id='root'></div>");
  const saved = Object.fromEntries(["window", "document", "IS_REACT_ACT_ENVIRONMENT", "fetch"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const pending = [];
  globalThis.fetch = async () => new Promise(resolve => pending.push(resolve));
  const root = createRoot(dom.window.document.getElementById("root"));
  const props = { projectId: "project:one", storyId: "story:one", storyDigest: `sha256:${"a".repeat(64)}`, canonicalUrl: "https://example.invalid/article" };
  const record = (projectId, text) => ({ tenantId: "tenant:fixture", workspaceId: "workspace:fixture", ...props, projectId,
    status: "extracted", sourceHash: `sha256:${"b".repeat(64)}`, detailDigest: `sha256:${"c".repeat(64)}`,
    extractor: "@mozilla/readability@0.6.0+jsdom@26.1.0", text });
  try {
    await act(async () => root.render(React.createElement(NewsArticleReader, props)));
    assert.match(dom.window.document.body.textContent, /Read saved article/);
    assert.equal(pending.length, 0);
    await act(async () => dom.window.document.querySelector("button").click());
    assert.equal(pending.length, 1);
    await act(async () => root.render(React.createElement(NewsArticleReader, { ...props, projectId: "project:two" })));
    assert.equal(pending.length, 2);
    await act(async () => pending[0](Response.json(record("project:one", "OLD PROJECT SECRET"))));
    assert.doesNotMatch(dom.window.document.body.textContent, /OLD PROJECT SECRET/);
    await act(async () => pending[1](Response.json(record("project:two", "Saved **article** text"))));
    assert.match(dom.window.document.body.textContent, /Untrusted source content/);
    assert.match(dom.window.document.body.textContent, /Saved article text/);
    assert.equal(dom.window.document.querySelector("textarea").value, "Saved **article** text");
    await act(async () => dom.window.dispatchEvent(new dom.window.Event("focus")));
    assert.equal(dom.window.document.querySelector("textarea"), null);
    await act(async () => pending[2](new Response("", { status: 401 })));
    assert.match(dom.window.document.body.textContent, /check your access/);
    assert.equal(dom.window.document.querySelector("textarea"), null);
    await act(async () => dom.window.document.querySelector("button").click());
    assert.equal(dom.window.document.querySelector("textarea"), null);
    await act(async () => dom.window.document.querySelector("button").click());
    await act(async () => pending[3](new Response("", { status: 404 })));
    assert.match(dom.window.document.body.textContent, /No saved article text yet/);
    assert.equal(dom.window.document.querySelector("textarea"), null);
  } finally {
    await act(async () => root.unmount()); dom.window.close();
    for (const [key, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    }
  }
});
