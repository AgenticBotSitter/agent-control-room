import assert from "node:assert/strict";
import test from "node:test";
import { useVisiblePolling } from "../private-app/app/use-visible-polling";

test("visible polling reads on mount, pauses while hidden, and resumes once visible", async () => {
  const { JSDOM } = await import("jsdom");
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const dom = new JSDOM('<div id="root"></div>', { url: "https://control.invalid/", pretendToBeVisual: true });
  const saved = Object.fromEntries(["window", "document", "IS_REACT_ACT_ENVIRONMENT"].map(key =>
    [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  let hidden = false, reads = 0;
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  Object.defineProperty(dom.window.document, "hidden", { configurable: true, get: () => hidden });
  function Probe() { useVisiblePolling(async () => { reads += 1; }, true, 60_000); return null; }
  const root = createRoot(dom.window.document.getElementById("root")!);
  const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
  try {
    await React.act(async () => { root.render(React.createElement(Probe)); });
    await React.act(async () => { await tick(); });
    assert.equal(reads, 1, "a visible mounted view reads saved state once");
    hidden = true;
    await React.act(async () => { dom.window.document.dispatchEvent(new dom.window.Event("visibilitychange")); await tick(); });
    assert.equal(reads, 1, "a hidden document does not poll");
    hidden = false;
    await React.act(async () => { dom.window.document.dispatchEvent(new dom.window.Event("visibilitychange")); await tick(); });
    assert.equal(reads, 2, "returning to a visible document resumes one read");
  } finally {
    await React.act(async () => { root.unmount(); });
    dom.window.close();
    for (const [key, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  }
});
