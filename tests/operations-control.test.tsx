import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { OperationsControlPanel } from "../private-app/app/operations-control.tsx";

test("the operations control panel discloses it is not yet enforced, without a details toggle", () => {
  const html = renderToStaticMarkup(createElement(OperationsControlPanel));
  assert.match(html, /Pause, drain or stop/);
  assert.match(html, /This is a signal only, stored in this browser\./);
  assert.match(html, /task claiming, dispatch or running work currently checks it\./);
  // The safety disclosure must not be hidden behind a toggle a reload-only
  // owner could miss.
  assert.doesNotMatch(html, /<details/);
  for (const label of ["Pause new claims", "Draining", "Stopped"]) assert.match(html, new RegExp(`>${label}<`));
});

async function mountOperationsControl() {
  const jsdomModule = await import("jsdom");
  const JSDOM = (jsdomModule as { JSDOM: unknown }).JSDOM as new (
    html: string, options?: { url?: string; pretendToBeVisual?: boolean },
  ) => { window: Window & typeof globalThis };
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const dom = new JSDOM('<div id="root"></div>', { url: "https://control.invalid/", pretendToBeVisual: true });
  const saved = Object.fromEntries(["window", "document", "IS_REACT_ACT_ENVIRONMENT"]
    .map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const root = createRoot(dom.window.document.getElementById("root")!);
  await React.act(async () => { root.render(React.createElement(OperationsControlPanel)); });
  const restore = async () => {
    try { await React.act(async () => { root.unmount(); }); } catch { /* already torn down */ }
    dom.window.close();
    for (const [key, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  };
  return { document: dom.window.document, window: dom.window, root, act: React.act, restore };
}

test("clicking a state stores it and survives a fresh mount in the same browser", async () => {
  const mounted = await mountOperationsControl();
  try {
    assert.match(mounted.document.body.textContent ?? "", /Running/);
    const drain = [...mounted.document.querySelectorAll("button")].find(button => button.textContent === "Draining");
    assert.ok(drain);
    await mounted.act(async () => { drain!.click(); });
    assert.match(mounted.document.body.textContent ?? "", /Draining/);
    assert.equal(JSON.parse(mounted.window.localStorage.getItem("control-room:operations-control:v1")!).state, "draining");

    // A second mount, in the same jsdom window (so the same localStorage),
    // reads the stored state back — the entire promise this control makes:
    // it survives a reload on this one browser, and nothing more.
    const { createRoot } = await import("react-dom/client");
    const React = await import("react");
    const second = mounted.document.createElement("div");
    mounted.document.body.appendChild(second);
    const secondRoot = createRoot(second);
    await mounted.act(async () => { secondRoot.render(React.createElement(OperationsControlPanel)); });
    assert.match(second.textContent ?? "", /Draining/);
    await mounted.act(async () => { secondRoot.unmount(); });
  } finally { await mounted.restore(); }
});

test("an unusable stored value falls back to Running rather than throwing", async () => {
  const mounted = await mountOperationsControl();
  try {
    mounted.window.localStorage.setItem("control-room:operations-control:v1", "not json");
    const { createRoot } = await import("react-dom/client");
    const React = await import("react");
    const second = mounted.document.createElement("div");
    mounted.document.body.appendChild(second);
    const root = createRoot(second);
    await mounted.act(async () => { root.render(React.createElement(OperationsControlPanel)); });
    assert.match(second.textContent ?? "", /Running/);
    await mounted.act(async () => { root.unmount(); });
  } finally { await mounted.restore(); }
});
