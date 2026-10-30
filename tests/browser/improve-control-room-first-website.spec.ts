import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { B5_REQUEST_TEXT, syntheticFirstWebsiteFixtureV1 } from "../helpers/improve-control-room-first-website";
import { now, request } from "../helpers/web-foundation";
// SYNTHETIC fixture walk of the B5 owner journey at phone and desktop widths. It is not
// actual-device evidence and cannot satisfy the real proof. The host advances saved
// state between browser contexts with no browser request.
const emptyTasks = { items: [], nextCursor: null, examined: 0, observedAt: new Date(now).toISOString(), startsWork: false, planningSource: "configured", deliverySource: "configured", sources: { ordinary: "included", ideas: "not_configured" } };
for (const width of [360, 1280]) test(`B5 fixture owner journey survives closed browsers and restarts at ${width}px`, async ({ browser }) => {
  const f = await syntheticFirstWebsiteFixtureV1();
  let context: BrowserContext | undefined, deny = false, unavailable = false, truncated = false;
  const unexpected: string[] = [], posts: string[] = [];
  try {
    const bundle = await build({ write: false, bundle: true, platform: "browser", format: "iife", jsx: "automatic", stdin: { resolveDir: process.cwd(), loader: "tsx", contents: `
      import React from 'react';import {createRoot} from 'react-dom/client';
      import {HomeDashboard} from './private-app/app/home-workspace';
      import {PrivateHeader} from './private-app/app/private-header';
      import {PrivateActionInbox} from './private-app/app/needs-me/action-inbox';
      import {PrivateImproveControlRoomWorkspace} from './private-app/app/improve-control-room-workspace';
      import {LocalRuntimeContextV1} from './private-app/app/local-runtime';
      import {useSharedTaskAttention} from './private-app/app/shared-task-attention';
      function Home(){const attention=useSharedTaskAttention(true);return <><PrivateHeader/><main><HomeDashboard data={{activity:{state:'unavailable'},projects:{state:'unavailable'},
        connections:{state:'ready',value:{source:'local',value:{taskWorkersStarted:true,workers:[],projectSections:[]}}},attention}}/></main></>}
      const path=window.location.pathname;
      createRoot(document.getElementById('root')).render(<LocalRuntimeContextV1.Provider value={{mode:'hosted'}}>{path==='/'?<Home/>:path==='/needs-me'?<><PrivateHeader/><PrivateActionInbox/></>:<PrivateImproveControlRoomWorkspace projectId=${JSON.stringify(f.project.projectId)}/>}</LocalRuntimeContextV1.Provider>);
    ` }, plugins: [{ name: "unused-legacy-crypto", setup(b) { b.onResolve({ filter: /^node:crypto$/ }, () => ({ path: "node:crypto", namespace: "unused" })); b.onLoad({ filter: /.*/, namespace: "unused" }, () => ({ contents: 'export function createHash(){throw new Error("unused_legacy_crypto")}', loader: "js" })); } }] });
    const css = (await Promise.all(["node_modules/tailwindcss/preflight.css", "styles/control-room.css", "private-app/app/private.css"].map(p => readFile(p, "utf8")))).join("\n");
    const open = async (path: string) => {
      context = await browser.newContext({ viewport: { width, height: 850 }, isMobile: width < 500, hasTouch: width < 500 });
      await context.addInitScript(() => Object.defineProperty(navigator, "onLine", { get: () => true }));
      await context.route("**/*", async route => {
        const r = route.request(), url = new URL(r.url());
        if (url.origin !== "https://product.invalid") { unexpected.push(r.url()); await route.abort(); return; }
        if (url.pathname === "/bundle.js") { await route.fulfill({ contentType: "application/javascript", body: bundle.outputFiles[0]!.text }); return; }
        if (r.isNavigationRequest()) { await route.fulfill({ contentType: "text/html", body: `<meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script src="/bundle.js"></script>` }); return; }
        if (r.method() !== "GET") posts.push(url.pathname);
        if (url.pathname === "/api/v1/needs-me/tasks") { await route.fulfill({ json: emptyTasks }); return; }
        if (url.pathname === "/api/v1/needs-me/action-items" && deny) { await route.fulfill({ status: 403, json: { error: "access_denied" } }); return; }
        if (url.pathname === "/api/v1/needs-me/action-items" && unavailable) { await route.fulfill({ status: 503, json: { error: "unavailable" } }); return; }
        if (url.pathname.startsWith("/api/")) {
          const key = r.headers()["idempotency-key"] ?? "b5-browser-read-0001";
          const response = await f.handle(request(url.pathname, r.method(), r.postData() ? JSON.parse(r.postData()!) : undefined, key));
          if (url.pathname === "/api/v1/needs-me/action-items" && truncated && response.status === 200) { const body = await response.json(); body.loop.truncated = true; await route.fulfill({ json: body }); return; }
          await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() }); return;
        }
        unexpected.push(r.url()); await route.abort();
      });
      const page = await context.newPage(); await page.goto("https://product.invalid" + path); return page;
    };
    const close = async () => { await context!.close(); context = undefined; };
    const badge = async (page: Page, value: string) => {
      if (width < 500) await page.getByRole("button", { name: "Menu", exact: true }).click();
      await expect(page.locator('nav a[href="/needs-me"]')).toHaveAccessibleDescription(value);
      if (width < 500) await page.getByRole("button", { name: "Menu", exact: true }).click();
    };
    const target = async (locator: ReturnType<Page["locator"]>) => expect(await locator.evaluate(e => e.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
    const projectPath = `/projects/${encodeURIComponent(f.project.projectId)}/improvements`;
    // 01 Prepare: exact bytes; no clone, plan or Start before confirmation.
    let page = await open(projectPath); expect(posts).toEqual([]);
    await page.getByLabel("What would you like improved?").fill(B5_REQUEST_TEXT);
    await page.getByRole("button", { name: "Prepare request", exact: true }).click();
    const confirm = page.getByRole("button", { name: "Confirm this exact request" }); await expect(confirm).toBeEnabled(); await target(confirm);
    expect(f.calls).toEqual(["intake"]);
    await page.screenshot({ path: test.info().outputPath(`01-prepare-${width}.png`) });
    const requestId = (await f.desk.viewLoopDesk(f.identity, f.project.projectId)).loopRequests[0]!.requestId;
    const savedPath = `${projectPath}#request=${encodeURIComponent(requestId)}`;
    expect(await page.locator('[aria-label="Saved owner decision"]').textContent()).toContain(B5_REQUEST_TEXT);
    // 02 Confirm, then separately Start. Confirmation alone causes zero Start.
    await confirm.click(); const start = page.getByRole("button", { name: "Start confirmed work", exact: true }); await expect(start).toBeEnabled();
    expect(f.calls).toEqual(["intake", "confirm"]); await target(start);
    await start.click(); await expect(page.getByText("Work is running", { exact: true })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath(`02-confirm-start-${width}.png`) });
    // Closed browser: the owned host reaches the real-shaped question with no request.
    await close(); const closedPosts = posts.length;
    expect(await f.tick()).toBe("question"); expect(posts).toHaveLength(closedPosts);
    // 03 Reopen Home at the question: one attention item, header, nav and Inbox.
    page = await open("/");
    await expect(page.locator('header [aria-label="Needs attention"]')).toContainText("Answer saved question"); await badge(page, "1");
    const launches = f.launches(); await f.tick(); await f.tick(); expect(f.launches()).toBe(launches);
    await close(); await f.restart(); page = await open("/needs-me");
    const answerLink = page.getByRole("link", { name: "Answer question", exact: true }).last(); await expect(answerLink).toBeVisible(); await badge(page, "1");
    await answerLink.click(); await expect(page).toHaveURL("https://product.invalid" + savedPath);
    expect(await page.locator('[aria-label="Saved owner decision"]').textContent()).toContain(f.questionText);
    await page.screenshot({ path: test.info().outputPath(`03-question-${width}.png`) });
    // 04-05 Website answer, then the complete sealed plan and spec, each approved separately.
    await page.getByLabel("Your answer").fill("Amber.");
    const send = page.getByRole("button", { name: "Send answer", exact: true }); await target(send); await send.click();
    await expect(page.getByText("Work is running", { exact: true })).toBeVisible(); expect(f.answer()).toBe("Amber.");
    for (const step of ["plan", "spec"] as const) {
      expect(await f.tick()).toBe(`${step}-waiting`);
      await page.getByRole("button", { name: "Refresh status", exact: true }).click();
      await expect(page.locator('[aria-label="Saved owner decision"] pre')).toHaveText(f.documents[step]);
      const approve = page.getByRole("button", { name: `Approve this ${step}`, exact: true }); await expect(approve).toBeEnabled(); await target(approve);
      await page.screenshot({ path: test.info().outputPath(`0${step === "plan" ? 4 : 5}-${step}-${width}.png`) });
      await approve.click(); await expect(page.getByText("Work is running", { exact: true })).toBeVisible();
    }
    // Closed again: build, reviewer rejection, original-builder repair, fresh reviews.
    await close(); expect(await f.tick()).toBe("finished");
    expect(f.steps.map(s => `${s.role}:${s.verdict}`).slice(5, 8)).toEqual(["build:DONE", "code-review:NEEDS-FIX", "build:DONE"]);
    // 06-08 Reopen the same saved request. At BASE the website-started run cannot publish
    // its B4 card (BUILD-B5 BLOCKED), so the honest unavailable label is shown.
    page = await open(savedPath);
    await expect(page.getByText("Completion reported; candidate evidence unavailable", { exact: true })).toBeVisible();
    await expect(page.getByRole("article", { name: "Finished candidate", exact: true })).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath(`06-finished-${width}.png`) });
    const before = posts.length; await page.reload(); await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await page.goto("https://product.invalid/needs-me"); await page.goBack(); expect(posts).toHaveLength(before);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    // 09 Owned service restart: same saved request, still no card fabricated.
    await close(); await f.restart(); page = await open(savedPath);
    await expect(page.getByText("Completion reported; candidate evidence unavailable", { exact: true })).toBeVisible();
    truncated = true; await page.goto("https://product.invalid/"); await badge(page, "0+");
    truncated = false; unavailable = true; await page.reload(); await badge(page, "?");
    unavailable = false; deny = true; await page.reload();
    await expect(page.locator('header [aria-label="Needs attention"]')).toContainText("sign in again");
    expect(posts.filter(p => !/\/improvements\/loop\/(?:intake|[^/]+\/(?:confirm|start|answer|approve))$/u.test(p))).toEqual([]);
    expect(f.calls.filter(c => c === "start")).toHaveLength(1); expect(f.calls).not.toContain("stop");
    expect(unexpected).toEqual([]);
  } finally { await context?.close(); await f.close(); }
});
