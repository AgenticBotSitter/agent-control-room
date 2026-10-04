import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { build } from "esbuild";
import { chromium } from "@playwright/test";

// Mount real components and production CSS, with only read-only HTTP fixtures.
// The route intercept serves every resource; no application server or DB is used.
test("R7IPOL: attention links are 44x44 at 320px; desktop geometry stays unchanged", { timeout: 60000 }, async () => {
  const css = await readFile("private-app/app/private.css", "utf8");
  const globalCss = await readFile("styles/control-room.css", "utf8");
  const baselineCss = css.replace(/\/\* Standalone attention links need the phone target floor[^]*?\n}\n/, "");
  const { outputFiles } = await build({ stdin: { resolveDir: process.cwd(), loader: "tsx", contents: `
    import React from "react";
    import { createRoot } from "react-dom/client";
    import { PrivateHeader } from "./private-app/app/private-header";
    import { PrivateActionInbox } from "./private-app/app/needs-me/action-inbox";
    import { HomeDashboard } from "./private-app/app/home-workspace";
    import { LocalRuntimeContextV1 } from "./private-app/app/local-runtime";
    import { useSharedTaskAttention } from "./private-app/app/shared-task-attention";
    function Home() {
      const attention = useSharedTaskAttention(true);
      return <HomeDashboard data={{ projects: { state: "loading" }, activity: { state: "loading" },
        attention, connections: { state: "ready", value: { source: "local", value: { workers: [] } } } }} />;
    }
    const root = createRoot(document.getElementById("root"));
    root.render(<LocalRuntimeContextV1.Provider value={{ mode: "hosted" }}><div className="private-shell">
      <PrivateHeader /><main><Home /><PrivateActionInbox /></main></div></LocalRuntimeContextV1.Provider>);
    globalThis.unmount = () => root.unmount();
  ` }, bundle: true, platform: "browser", format: "iife", write: false,
    banner: { js: "globalThis.Buffer = { byteLength: text => new TextEncoder().encode(text).length };" },
    // Configuration imports a server digest helper; these UI reads never hash.
    // Refuse any accidental call rather than supplying a fake digest.
    plugins: [{ name: "refuse-server-hashing", setup(builder) {
      builder.onResolve({ filter: /^node:crypto$/ }, () => ({ path: "crypto", namespace: "fixture" }));
      builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: 'export function createHash() { throw new Error("server hashing reached browser fixture"); }' }));
    } }] });
  const observedAt = "2026-10-02T09:00:00.000Z";
  const attentionPage = { items: [{ task: { projectId: "project:alpha", jobId: "job:Approve", requestId: "request:fixture", title: "Approve",
    state: "waiting_approval", version: 1, createdAt: observedAt, updatedAt: observedAt }, inputDigest: `sha256:${"a".repeat(64)}`, reasons: ["approval"] }],
    nextCursor: null, examined: 1, observedAt, startsWork: false, planningSource: "configured", deliverySource: "configured",
    sources: { ordinary: "included", ideas: "not_configured" } };
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    for (const width of [320, 1280]) {
      const page = await browser.newPage({ viewport: { width, height: 800 } });
      try {
        const errors = [];
        page.on("pageerror", error => errors.push(error.message));
        await page.route("**/*", async route => {
          const path = new URL(route.request().url()).pathname;
          if (path === "/") return route.fulfill({ contentType: "text/html", body: '<style id="base"></style><style id="private"></style><div id="root"></div>' });
          if (path === "/api/v1/needs-me/tasks") return route.fulfill({ json: attentionPage });
          if (path === "/api/v1/needs-me/action-items") return route.fulfill({ json: { observedAt, items: [], truncated: false } });
          return route.fulfill({ status: 404 });
        });
        await page.goto("http://127.0.0.1:3299/", { timeout: 10000 });
        await page.evaluate(({ css, globalCss }) => {
          document.querySelector("#base").textContent = globalCss;
          document.querySelector("#private").textContent = css;
        }, { css, globalCss });
        await page.addScriptTag({ content: outputFiles[0].text });
        const selector = '.private-attention-box li a';
        await page.waitForFunction(selector => document.querySelectorAll(selector).length === 2, selector, { timeout: 10000 });
        await page.waitForFunction(() => document.querySelector('[aria-labelledby="action-inbox-heading"]')?.textContent.includes("Approve"), null, { timeout: 10000 });
        const measure = () => page.locator(selector).evaluateAll(links => links.map(link => {
          const { width, height, x, y } = link.getBoundingClientRect();
          const style = getComputedStyle(link);
          return { width, height, x, y, display: style.display, fontSize: style.fontSize, padding: style.padding };
        }));
        const boxes = await measure();
        if (width === 320) {
          for (const box of boxes) { assert.ok(box.width >= 44, JSON.stringify(box)); assert.ok(box.height >= 44, JSON.stringify(box)); }
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        } else {
          await page.evaluate(css => { document.querySelector("#private").textContent = css; }, baselineCss);
          assert.deepEqual(await measure(), boxes, "desktop size, position and styling match the previous CSS");
        }
        assert.deepEqual(errors, []);
        await page.evaluate(() => globalThis.unmount());
      } finally { await page.close(); }
    }
  } finally { await browser?.close(); }
});
