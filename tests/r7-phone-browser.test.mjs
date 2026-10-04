import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { build } from "esbuild";
import { chromium } from "@playwright/test";

// the reviewer's sw-firstload/sw-press, action-detail, resume-class, action-slow-reply and
// narrow-table-reach/narrow-large-text scenarios, converted to assertions.
// Real worker lifecycle and sockets; production components/CSS; no database.
test("R7P: real worker update, retained offline draft, resume at 320px, and reachable large-text Reason", { timeout: 90000 }, async () => {
  const [css, globalCss, workerSource] = await Promise.all([
    readFile("private-app/app/private.css", "utf8"), readFile("styles/control-room.css", "utf8"),
    readFile("private-app/app/service-worker.js", "utf8") ]);
  const { outputFiles } = await build({ stdin: { resolveDir: process.cwd(), loader: "tsx", contents: `
    import React from "react"; import { createRoot } from "react-dom/client";
    import { PwaRegistration } from "./private-app/app/pwa-registration";
    import { PrivateProjectWorkspace } from "./private-app/app/workspace";
    import { NotificationDecisionList } from "./private-app/app/notification-settings";
    import { LocalRuntimeContextV1 } from "./private-app/app/local-runtime";
    const root = createRoot(document.getElementById("root"));
    const record = { key: "notice:phone", title: "Saved phone notification", needKind: "owner_review", severity: "urgent", state: "notify", reasonCode: "new_meaningful_state" };
    root.render(location.pathname === "/pwa" ? <PwaRegistration /> : location.pathname === "/settings"
      ? <div className="private-shell"><main><section className="private-panel"><NotificationDecisionList decisions={[record]} /></section></main></div>
      : <LocalRuntimeContextV1.Provider value={{mode:"hosted"}}><PrivateProjectWorkspace projectId={location.pathname.split("/")[2] ? decodeURIComponent(location.pathname.split("/")[2]) : undefined} /></LocalRuntimeContextV1.Provider>);
    globalThis.unmount = () => root.unmount();
  ` }, bundle: true, platform: "browser", format: "iife", write: false,
    banner: { js: "globalThis.Buffer = { byteLength: text => new TextEncoder().encode(text).length };" },
    plugins: [{ name: "refuse-server-hashing", setup(builder) {
      builder.onResolve({ filter: /^node:crypto$/ }, () => ({ path: "crypto", namespace: "fixture" }));
      builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: 'export function createHash() { throw new Error("server hashing reached browser fixture"); }' }));
    } }] });
  let version = 1, holdReads = false, projectReads = 0, posts = 0;
  const held = new Set(), timers = new Set();
  let savedProject;
  const catalog = { projects: [], nextCursor: null, canCreate: true, sources: { ordinary: "included", ideas: "not_configured" } };
  const server = createServer((request, response) => {
    const path = new URL(request.url, "http://localhost").pathname;
    response.setHeader("cache-control", "no-store");
    if (path === "/service-worker.js") { response.setHeader("content-type", "text/javascript"); response.end(workerSource + `\n// phone fixture version ${version}`); }
    else if (path === "/bundle.js") { response.setHeader("content-type", "text/javascript"); response.end(outputFiles[0].text); }
    else if (path === "/api/v1/projects") {
      if (request.method === "POST") {
        posts++; let body = ""; request.on("data", chunk => { body += chunk; });
        request.on("end", () => {
          const draft = JSON.parse(body);
          const timer = setTimeout(() => {
            timers.delete(timer);
            savedProject = { projectId: "project:slow-phone", title: draft.title, summary: draft.summary, lifecycle: "active", version: 1,
              createdAt: "2026-10-02T00:00:00.000Z", updatedAt: "2026-10-02T00:00:00.000Z" };
            catalog.projects = [{ ...savedProject, origin: "ordinary", lifecycleEditable: true }];
            response.writeHead(201, { "content-type": "application/json" }); response.end(JSON.stringify({ project: savedProject, replayed: false }));
          }, 4000); timers.add(timer);
        });
      }
      else { projectReads++; response.setHeader("content-type", "application/json");
        if (holdReads) { held.add(response); response.on("close", () => held.delete(response)); }
        else response.end(JSON.stringify(catalog)); }
    } else if (path === "/api/v1/projects/project%3Aslow-phone" && savedProject) {
      response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ project: { ...savedProject, origin: "ordinary", lifecycleEditable: true } }));
    } else if (path.startsWith("/api/")) { response.writeHead(404); response.end(); }
    else { response.setHeader("content-type", "text/html"); response.end(`<html><meta name="viewport" content="width=device-width,initial-scale=1"><style>${globalCss}\n${css}</style><div id="root"></div><script src="/bundle.js"></script></html>`); }
  });
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const origin = `http://127.0.0.1:${server.address().port}`;
    const context = await browser.newContext({ viewport: { width: 320, height: 568 }, isMobile: true, hasTouch: true });
    try {
      const page = await context.newPage();
      await page.goto(`${origin}/pwa`);
      await page.evaluate(() => navigator.serviceWorker.ready);
      assert.equal(await page.getByRole("button", { name: "Reload for update", exact: true }).count(), 0, "first install is not an update");
      await page.reload();
      await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
      version++;
      await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
      await page.getByRole("button", { name: "Reload for update", exact: true }).waitFor();
      await page.evaluate(() => { window.sentinel = "before-update"; });
      await page.getByRole("button", { name: "Reload for update", exact: true }).click();
      await page.waitForFunction(() => !window.sentinel);
      assert.equal(await page.getByRole("button", { name: "Reload for update", exact: true }).count(), 0);

      await page.goto(`${origin}/projects`);
      await page.locator("#project-title").fill("Draft the owner typed");
      await page.locator("#project-summary").fill("A summary written on the phone.");
      await context.setOffline(true);
      await page.getByRole("button", { name: "Create project", exact: true }).click();
      await page.getByText(/project was not sent/).waitFor();
      assert.equal(posts, 0); assert.equal(await page.locator("#project-title").inputValue(), "Draft the owner typed");
      assert.equal(await page.locator("#project-summary").inputValue(), "A summary written on the phone.");
      await context.setOffline(false);
      holdReads = true; const before = projectReads;
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await page.waitForFunction(() => document.querySelector("main")?.textContent.includes("Checking…"));
      assert.ok(projectReads > before);
      await page.evaluate(() => {
        Object.defineProperty(document, "hidden", { configurable: true, value: true }); document.dispatchEvent(new Event("visibilitychange"));
      });
      assert.equal(await page.locator("#project-title").inputValue(), "Draft the owner typed");
      assert.doesNotMatch(await page.locator("main").innerText(), /Projects are unavailable/);
      holdReads = false; for (const response of held) response.end(JSON.stringify(catalog));
      const resume = projectReads;
      await page.evaluate(() => {
        Object.defineProperty(document, "hidden", { configurable: true, value: false }); document.dispatchEvent(new Event("visibilitychange"));
      });
      await page.waitForFunction(() => !document.querySelector("main")?.textContent.includes("Checking…"));
      assert.ok(projectReads > resume); assert.equal(await page.locator("#project-title").inputValue(), "Draft the owner typed");
      assert.doesNotMatch(await page.locator("main").innerText(), /Projects are unavailable|couldn't refresh/i);

      await page.locator("#project-title").fill("Slow but saved");
      await page.locator("#project-summary").fill("Two taps on a four-second connection.");
      await page.getByRole("button", { name: "Create project", exact: true }).click();
      await page.getByRole("button", { name: "Saving…", exact: true }).evaluate(button => button.click());
      await page.waitForURL(`${origin}/projects/project%3Aslow-phone`, { timeout: 10000 });
      await page.getByRole("heading", { name: "Slow but saved", exact: true }).waitFor();
      assert.equal(posts, 1); assert.equal(savedProject.title, "Slow but saved");
      assert.doesNotMatch(await page.locator("main").innerText(), /could not be confirmed/);
      await page.goto(`${origin}/settings`);
      await page.locator("table").waitFor();
      for (const fontSize of [16, 20]) {
        await page.evaluate(size => { document.documentElement.style.fontSize = `${size}px`; }, fontSize);
        const result = await page.locator("table").evaluate(table => {
          const wrapper = table.parentElement; wrapper.scrollLeft = 9999;
          const reason = table.querySelector("tbody td:last-child"); const box = reason.getBoundingClientRect();
          return { reachable: box.right <= innerWidth + 1 && box.left >= 0, reason: reason.textContent,
            scrollable: getComputedStyle(wrapper).overflowX === "auto", documentWidth: document.documentElement.scrollWidth, width: innerWidth };
        });
        assert.equal(result.scrollable, true); assert.equal(result.reachable, true, JSON.stringify(result));
        assert.ok(result.reason?.trim(), "reason is rendered, not merely an empty reachable cell");
        assert.equal(result.documentWidth, result.width);
      }
      await page.evaluate(() => globalThis.unmount());
    } finally { await context.close(); }
  } finally {
    await browser?.close();
    for (const timer of timers) clearTimeout(timer);
    for (const response of held) response.destroy();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
});
