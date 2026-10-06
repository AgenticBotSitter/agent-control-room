import assert from "node:assert/strict";
import test from "node:test";
import { act } from "react";
import { renderToString } from "react-dom/server";
import { hydrateRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { PrivateSettingsWorkspace } from "../private-app/app/settings/workspace";
import { LocalRuntimeProvider } from "../private-app/app/local-runtime";
import { ProductConfigurationProvider } from "../private-app/app/product-configuration";
import { InstallationTopologyProvider } from "../private-app/app/installation-topology";

const settings = () => <LocalRuntimeProvider><ProductConfigurationProvider>
  <InstallationTopologyProvider><PrivateSettingsWorkspace /></InstallationTopologyProvider>
</ProductConfigurationProvider></LocalRuntimeProvider>;

test("settings server markup hydrates without warnings before client capability and setup reads settle", async () => {
  for (const pushSupported of [true, false]) {
    const keys = ["window", "document", "navigator", "fetch", "IS_REACT_ACT_ENVIRONMENT"];
    const saved = keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
    const errors: unknown[] = [], warnings: unknown[][] = [];
    const originalError = console.error;
    let root: Root | undefined;
    let dom: JSDOM | undefined;
    try {
      Reflect.deleteProperty(globalThis, "window");
      Reflect.deleteProperty(globalThis, "document");
      const html = renderToString(settings());
      assert.match(html, /Checking phone notifications/);
      assert.doesNotMatch(html, /Saved setup proof is unavailable|Saved setup progress is unavailable/);
      dom = new JSDOM(`<div id="root">${html}</div>`, { url: "https://control-room.example/settings", pretendToBeVisual: true });
      for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document,
        navigator: dom.window.navigator, IS_REACT_ACT_ENVIRONMENT: true })) {
        Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
      }
      if (pushSupported) {
        Object.defineProperty(dom.window.navigator, "serviceWorker", { value: {} });
        Object.defineProperty(dom.window, "PushManager", { value: class {} });
        Object.defineProperty(dom.window, "Notification", { value: class {} });
      }
      let releaseRuntime!: (response: Response) => void;
      const runtime = new Promise<Response>(resolve => { releaseRuntime = resolve; });
      globalThis.fetch = (async input => String(input) === "/api/v1/local-workers"
        ? runtime : new Response(null, { status: 404 })) as typeof fetch;
      console.error = (...args: unknown[]) => { warnings.push(args); };
      await act(async () => {
        root = hydrateRoot(dom!.window.document.getElementById("root")!, settings(),
          { onRecoverableError: error => { errors.push(error); } });
      });
      assert.deepEqual(errors, [], `initial hydration, push supported: ${pushSupported}`);
      assert.deepEqual(warnings, [], "hydration must not emit a mismatch warning");
      assert.equal(!!dom.window.document.querySelector("#owner-web-push-heading")?.parentElement
        ?.textContent?.includes("Retry notification setup"), pushSupported);
      assert.match(dom.window.document.body.textContent!, pushSupported
        ? /Phone notifications are unavailable/ : /This browser does not support Web Push/);
      await act(async () => releaseRuntime(new Response(JSON.stringify({ taskWorkersStarted: false,
        workers: [], projectSections: [] }), { headers: { "content-type": "application/json" } })));
      assert.match(dom.window.document.body.textContent!, /Saved setup proof is unavailable/);
      assert.match(dom.window.document.body.textContent!, /Saved setup progress is unavailable/);
      assert.deepEqual(errors, [], "settled local mode is a normal update, not a hydration recovery");
      assert.deepEqual(warnings, []);
    } finally {
      if (root) await act(async () => root!.unmount());
      console.error = originalError;
      dom?.window.close();
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    }
  }
});
