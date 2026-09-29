import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { JSDOM } from "jsdom";
import { createRoot } from "react-dom/client";
import { PrivateTaskWorkspace } from "../private-app/app/task-workspace";

/**
 * The task-workspace read loop and the review workspace's authenticated-session
 * tracking were built on separate branches: one taught the loop to pause while
 * hidden and back off on failure, the other taught a 401 to invalidate the
 * session so a stale owner gesture cannot survive it. Merged carelessly, the
 * loop keeps re-issuing the same protected read against an already-invalidated
 * session every time the tab regains focus, which is exactly the fixed-interval
 * hammering the shared scheduler exists to prevent. A focus event is used here
 * instead of waiting out the real interval, because it is the scheduler's own
 * immediate return-to-tab signal and requires no timer at all.
 */
test("an invalidated session stops background polling until an explicit retry", async () => {
  const dom = new JSDOM("<div id='root'></div>", { url: "https://control.invalid/projects/project%3Aone/tasks/job%3Aone" });
  const saved = Object.fromEntries(["window", "document", "IS_REACT_ACT_ENVIRONMENT", "fetch", "crypto"].map(key =>
    [key, Object.getOwnPropertyDescriptor(globalThis, key)])) as Record<string, PropertyDescriptor | undefined>;
  Object.defineProperty(dom.window.document, "hidden", { configurable: true, get: () => false });
  let calls = 0;
  const fetchMock: typeof fetch = async () => { calls++; return new Response(null, { status: 401 }); };
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true, fetch: fetchMock });
  const root = createRoot(dom.window.document.getElementById("root")!);
  const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
  try {
    await React.act(async () => { root.render(<PrivateTaskWorkspace projectId="project:one" jobId="job:one" />); await flush(); });
    assert.equal(calls, 1, "mounting the page performs exactly one protected read");

    await React.act(async () => { dom.window.dispatchEvent(new dom.window.Event("focus")); await flush(); });
    assert.equal(calls, 1, "an invalidated session must not issue another protected read on focus");

    await React.act(async () => { dom.window.document.dispatchEvent(new dom.window.Event("visibilitychange")); await flush(); });
    assert.equal(calls, 1, "an invalidated session must not issue another protected read on visibility return");

    const retry = [...dom.window.document.querySelectorAll("button")]
      .find(button => button.textContent === "Check saved tasks again");
    assert.ok(retry, "the owner must still be able to explicitly ask for another read");
    await React.act(async () => { retry!.dispatchEvent(new dom.window.Event("click", { bubbles: true })); await flush(); });
    assert.equal(calls, 2, "an explicit owner retry must still issue a fresh read");
  } finally {
    await React.act(async () => { root.unmount(); });
    dom.window.close();
    for (const [key, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
