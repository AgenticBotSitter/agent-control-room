import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { createElement, act, useLayoutEffect, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { chromium } from "@playwright/test";
import { renderLocalOwnerSignInPageV1, LocalOwnerSessionServiceV1, LOCAL_OWNER_SESSION_PROFILE_V1 } from "../src/web/v1/local-owner-session";
import { sha256Digest } from "../src/security";
import { WebAccessError } from "../src/web/v1/access-verifier";
import { PrivateProjectWorkspace } from "../private-app/app/workspace";
import { ActionInboxPanel, type ActionInboxState } from "../private-app/app/needs-me/action-inbox";
import { OperationsControlPanel } from "../private-app/app/operations-control";
import { OwnerName } from "../private-app/app/owner-ui";
import { ProjectCatalog } from "../app/components/project-catalog";
import { HomeDashboard, type HomeDashboardState } from "../private-app/app/home-workspace";
import type { ProjectView } from "../src/web/v1/project-wire";
import { taskAttentionPageSchema, type TaskAttentionPage } from "../src/web/v1/task-attention-wire";

// Round-5 reproductions use mounted production components and synthetic replies.
import { ProjectSettingsPanel } from "../private-app/app/project-settings-panel";
import { ProjectCreateForm } from "../app/components/project-create-form";
import { projectSettingsSchema } from "../src/web/v1/project-settings-wire";
import { projectCoordinationPageSchema } from "../src/web/v1/project-coordination-wire";
import CoordinationPage from "../private-app/app/projects/[projectId]/coordination/page";


const now = "2026-10-01T12:00:00.000Z";
const project: ProjectView = { projectId: "project:one", title: "my mixedCase project", summary: "Purpose", lifecycle: "active",
  origin: "ordinary", lifecycleEditable: true, version: 1, createdAt: now, updatedAt: now };
const css = readFileSync(new URL("../private-app/app/private.css", import.meta.url), "utf8");
const preflight = readFileSync(new URL("../node_modules/tailwindcss/preflight.css", import.meta.url), "utf8");
const baseCss = readFileSync(new URL("../styles/control-room.css", import.meta.url), "utf8");

async function mounted(element: ReactElement, fetcher: typeof fetch) {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://127.0.0.1:59920/projects/project:one", pretendToBeVisual: true });
  const saved = Object.fromEntries(["window", "document", "fetch", "IS_REACT_ACT_ENVIRONMENT"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, fetch: fetcher, IS_REACT_ACT_ENVIRONMENT: true });
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(dom.window.document.getElementById("root")!);
  function restoreGlobals() {
    dom.window.close();
    for (const [key, value] of Object.entries(saved)) {
      if (value) Object.defineProperty(globalThis, key, value); else delete (globalThis as Record<string, unknown>)[key];
    }
  }
  try { await act(async () => { root.render(element); }); }
  catch (error) { await act(async () => root.unmount()); restoreGlobals(); throw error; }
  return { document: dom.window.document, window: dom.window, root,
    async close() {
      try { await act(async () => root.unmount()); }
      finally { restoreGlobals(); }
    } };
}
async function settle() { for (let i = 0; i < 12; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); }); }
async function click(m: Awaited<ReturnType<typeof mounted>>, name: string, count = 1) {
  const button = [...m.document.querySelectorAll("button")].find(b => b.textContent === name);
  assert.ok(button, `Missing ${name}: ${m.document.body.textContent}`);
  await act(async () => { for (let i = 0; i < count; i++) button.click(); });
  await settle();
}

test("R4U-13 sign-in explains the pause and offline failure, recovers and holds 50 duplicate submits", async () => {
  const html = await renderLocalOwnerSignInPageV1().text();
  const dom = new JSDOM(html, { url: "http://127.0.0.1:59920/session", runScripts: "dangerously", beforeParse(window: Window & typeof globalThis) {
    Object.assign(window, { AbortSignal });
  } } as { url: string });
  try {
    const form = dom.window.document.querySelector("form")!;
    (form.elements.namedItem("ownerCode") as HTMLInputElement).value = "a-valid-length-test-owner-code";
    Object.assign(dom.window, { fetch: async () => new Response(null, { status: 403 }) });
    form.dispatchEvent(new dom.window.Event("submit", { cancelable: true }));
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.match(dom.window.document.getElementById("message")!.textContent!, /Sign-in is paused.*Wait one minute/);
    let requests = 0;
    let respond: ((r: Response) => void) | undefined;
    Object.assign(dom.window, { fetch: (_input: unknown, init: RequestInit) => { requests++; return new Promise<Response>(resolve => { respond = resolve; }); } });
    for (let i = 0; i < 50; i++) form.dispatchEvent(new dom.window.Event("submit", { cancelable: true }));
    assert.equal(requests, 1, "one pending sign-in request");
    respond!(new Response(null, { status: 403 }));
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.match(dom.window.document.getElementById("message")!.textContent!, /Sign-in is paused.*Wait one minute/);
    Object.defineProperty(dom.window.navigator, "onLine", { value: false, configurable: true });
    Object.assign(dom.window, { fetch: async () => { throw new TypeError("offline"); } });
    form.dispatchEvent(new dom.window.Event("submit", { cancelable: true }));
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.match(dom.window.document.getElementById("message")!.textContent!, /You are offline/);
    Object.defineProperty(dom.window.navigator, "onLine", { value: true, configurable: true });
    form.dispatchEvent(new dom.window.Event("submit", { cancelable: true }));
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.match(dom.window.document.getElementById("message")!.textContent!, /Could not reach Control Room/);
    Object.assign(dom.window, { fetch: async () => new Response(null, { status: 401 }) });
    form.dispatchEvent(new dom.window.Event("submit", { cancelable: true }));
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.match(dom.window.document.getElementById("message")!.textContent!, /Check your owner code/);
    assert.equal(dom.window.document.querySelector("button")!.disabled, false);
    Object.assign(dom.window, { fetch: async () => new Response(null, { status: 503 }) });
    form.dispatchEvent(new dom.window.Event("submit", { cancelable: true }));
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.match(dom.window.document.getElementById("message")!.textContent!, /service is available/);
    assert.doesNotMatch(dom.window.document.getElementById("message")!.textContent!, /owner code/);
  } finally { dom.window.close(); }
  // Real issuer, injected time: valid code is refused within the failure window and accepted at its boundary.
  const origin = "http://127.0.0.1:59920", ownerCode = "a-valid-length-test-owner-code";
  const service = new LocalOwnerSessionServiceV1({ schema: LOCAL_OWNER_SESSION_PROFILE_V1, origin, tenantId: "tenant:test",
    provider: "local-owner", subject: "owner:test", ownerCodeDigest: sha256Digest({ ownerCode }), sessionSeconds: 900 });
  const req = () => new Request(`${origin}/api/v1/local-owner-session`, { method: "POST", headers: { origin } });
  for (let i = 0; i < 5; i++) await assert.rejects(service.issue(req(), "wrong", 1000), (e: unknown) => e instanceof WebAccessError && e.code === "authentication_required");
  const burst = await Promise.allSettled(Array.from({ length: 50 }, () => service.issue(req(), ownerCode, 1001)));
  assert.ok(burst.every(r => r.status === "rejected" && r.reason.code === "access_denied"));
  await assert.doesNotReject(service.issue(req(), ownerCode, 61000));
});

test("R4U-14 stale lifecycle refusal stays visible after refresh for ordinary and Idea Lab projects", async () => {
  for (const idea of [false, true]) {
    const namedProject = { ...project, title: "my mixedCase \u202eproject" };
    const initial: ProjectView = idea ? { ...namedProject, origin: "idea_lab", ideaLifecycleActions: ["pause", "archive"] } : namedProject;
    const updated: ProjectView = { ...initial, lifecycle: "paused", version: 2, ...(idea ? { ideaLifecycleActions: ["resume", "archive"] as const } : {}) } as ProjectView;
    let reads = 0, writes = 0;
    const m = await mounted(createElement(PrivateProjectWorkspace, { projectId: project.projectId, section: "settings" }), (async (input, init) => {
      const path = String(input);
      if (path === `/api/v1/projects/${encodeURIComponent(project.projectId)}` && init?.method === "GET") { reads++; return Response.json({ project: reads === 1 ? initial : updated }); }
      if (init?.method === "POST") { writes++; return new Response(null, { status: 409 }); }
      return new Response(null, { status: 404 });
    }) as typeof fetch);
    try {
      await settle();
      await click(m, "Archive project", 50);
      assert.equal(writes, 1, "50 stale taps issue one command");
      assert.ok(reads >= 2, "conflict refreshes the saved project");
      assert.match(m.document.body.textContent!, /changed in another tab/);
      assert.equal(m.document.querySelector("h1 bdi")!.textContent, "my mixedCase project");
      assert.ok([...m.document.querySelectorAll("button")].some(b => b.textContent === "Reopen project" || b.textContent === "Resume project"));
      await click(m, "Check saved state again");
      assert.match(m.document.body.textContent!, /changed in another tab/);
    } finally { await m.close(); }
  }
});

function inbox(): ActionInboxState {
  const pages = Array.from({ length: 13 }, (_, page) => taskAttentionPageSchema.parse({
    items: Array.from({ length: page === 12 ? 1 : 25 }, (_, i) => {
      const n = page * 25 + i;
      return { task: { projectId: project.projectId, jobId: `job:${n}`, requestId: `request:${n}`, title: `Task ${n}`,
        state: "proposed", version: 1, createdAt: now, updatedAt: now }, inputDigest: `sha256:${"a".repeat(64)}`,
        reasons: [n === 300 ? "failed" : "proposal"] };
    }), nextCursor: page === 12 ? null : `job:${page}`, examined: 25, observedAt: now, startsWork: false,
    planningSource: "configured", deliverySource: "configured", sources: { ordinary: "included", ideas: "not_configured" },
  }));
  return { tasks: { state: "available", pages, truncated: false }, operator: { state: "available", source: { items: [], observedAt: now, truncated: false } } };
}

test("R4U-16 inbox pages 301 actions with urgent work first and project names, retries missing names", async () => {
  const data = inbox(); let reads = 0, fail = false;
  const m = await mounted(createElement(ActionInboxPanel, { data }), (async () => { reads++; return fail ? new Response(null, { status: 404 }) : Response.json({ project }); }) as typeof fetch);
  try {
    await settle();
    const list = () => [...m.document.querySelectorAll('ol[aria-label="Action Inbox items"] > li')];
    assert.equal(list().length, 25);
    assert.equal([...m.document.querySelectorAll("button")].find(b => b.textContent === "Previous page")!.disabled, true);
    assert.match(list()[0]!.textContent!, /Task 300/);
    assert.match(list()[0]!.textContent!, /Project: my mixedCase project/);
    assert.doesNotMatch(m.document.body.textContent!, /Project: project:one/);
    assert.equal(reads, 1, "one name read per project, not per item");
    for (let i = 1; i < 13; i++) await click(m, "Next page");
    assert.equal(list().length, 1);
    assert.match(m.document.body.textContent!, /Page 13 of 13/);
    assert.equal([...m.document.querySelectorAll("button")].find(b => b.textContent === "Next page")!.disabled, true);
    await click(m, "Previous page"); assert.equal(list().length, 25);
    fail = true;
    await act(async () => m.root.render(createElement(ActionInboxPanel, { data: { ...data } })));
    await settle();
    assert.match(m.document.body.textContent!, /Project name unavailable/);
    assert.match(m.document.body.textContent!, /Page 1 of 13/);
    fail = false;
    await act(async () => m.root.render(createElement(ActionInboxPanel, { data: { ...data } })));
    await settle(); assert.match(m.document.body.textContent!, /Project: my mixedCase project/);
  } finally { await m.close(); }
});

test("R4U-15 reason field has a visible border at phone width", async t => {
  let browser;
  try { browser = await chromium.launch(); }
  catch (error) {
    if (String(error).includes("Executable doesn't exist")) { t.skip("Chromium is not provisioned in this environment"); return; }
    if (String(error).includes("bootstrap_check_in") && String(error).includes("Permission denied")) { t.skip("Chromium is blocked by the OS sandbox Mach-port policy"); return; }
    throw error;
  }
  try {
    const page = await browser.newPage({ viewport: { width: 375, height: 812 } });
    await page.setContent(`<style>${preflight}\n${baseCss}\n${css}</style><div class="private-shell">${renderToStaticMarkup(createElement(OperationsControlPanel))}</div>`);
    const style = await page.locator("#operations-control-reason").evaluate(el => { const s = getComputedStyle(el); return { border: parseFloat(s.borderTopWidth), kind: s.borderTopStyle, width: el.getBoundingClientRect().width }; });
    assert.ok(style.border >= 1 && style.kind !== "none");
    assert.ok(style.width <= 375);
  } finally { await browser.close(); }
});

test("R4U-17 phone controls reach 44 by 44 and displayed names retain spelling without bidi overrides", async t => {
  let browser;
  try { browser = await chromium.launch(); }
  catch (error) {
    if (String(error).includes("Executable doesn't exist")) { t.skip("Chromium is not provisioned in this environment"); return; }
    if (String(error).includes("bootstrap_check_in") && String(error).includes("Permission denied")) { t.skip("Chromium is blocked by the OS sandbox Mach-port policy"); return; }
    throw error;
  }
  try {
    const page = await browser.newPage({ viewport: { width: 375, height: 812 } });
    const name = "my mixedCase \u202eproject <b>";
    const catalog = renderToStaticMarkup(createElement(ProjectCatalog, { state: "ready", projects: [{ ...project, title: name }] }));
    await page.setContent(`<style>${preflight}\n${baseCss}\n${css}</style><div class="private-shell"><main><div class="private-panel"><label>Count<input type="number" value="1"></label><label>Enabled<input type="checkbox"></label><label>Rule<input value="rule"></label></div><ul class="private-dashboard-list"><li><span><a href="/projects">${renderToStaticMarkup(createElement(OwnerName, { children: name }))}</a></span></li></ul>${catalog}</main></div>`);
    for (const box of await page.locator("input").evaluateAll(els => els.map(el => { const r=el.getBoundingClientRect(); return { w:r.width, h:r.height }; }))) assert.ok(box.w >= 44 && box.h >= 44, JSON.stringify(box));
    assert.equal(await page.locator(".private-dashboard-list a").evaluate(el => getComputedStyle(el).textTransform), "none");
    for (const bdi of await page.locator("bdi").allTextContents()) { assert.equal(bdi, "my mixedCase project <b>"); }
    assert.equal(await page.locator("bdi b").count(), 0);
    // The unavailable response has its own styles, because no app shell is loaded.
    const host = readFileSync(new URL("../src/web/v1/mac-local-web-process.ts", import.meta.url), "utf8");
    const standalone = host.match(/return new Response\(`(<!doctype html><html lang="en"><meta charset="utf-8">[\s\S]*?)`, \{/u)![1]!;
    await page.setContent(standalone);
    const rect = await page.getByRole("link", { name: "Return to Projects" }).boundingBox();
    assert.ok(rect && rect.width >= 44 && rect.height >= 44);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= 375));
  } finally { await browser.close(); }
});

// Browser layout proof is separate from these permanent CSS/markup regressions.
// These also run where macOS refuses Chromium's Mach-port registration.
test("R4U-15 Reason uses the visible standalone editor border", () => {
  const dom = new JSDOM(`<style>${css.replaceAll("var(--border-strong)", "#c4c3b9").replaceAll("var(--field-border)", "#646860")}</style><div class="private-shell">${renderToStaticMarkup(createElement(OperationsControlPanel))}</div>`);
  try {
    const el = dom.window.document.querySelector("textarea")!;
    assert.equal(el.id, "operations-control-reason");
    // Native simulator defaults can supply a border that Tailwind preflight
    // removes in the app. Require an explicit author rule on this real field.
    assert.ok([...dom.window.document.styleSheets[0]!.cssRules].some(rule => {
      const styled = rule as CSSStyleRule;
      return styled.selectorText && el.matches(styled.selectorText) && /^1px solid /.test(styled.style.border);
    }), "Reason must receive an explicit visible border from its stylesheet");
    const style = dom.window.getComputedStyle(el);
    assert.equal(style.borderTopStyle, "solid"); assert.equal(style.borderTopWidth, "1px");
    assert.equal(style.display, "block");
  } finally { dom.window.close(); }
});

test("R4U-17 phone CSS covers inputs and standalone returns; actual project names are isolated unchanged", () => {
  const dom = new JSDOM(`<style>${css}</style>`);
  try {
    const rules = [...dom.window.document.styleSheets[0]!.cssRules];
    const phone = rules.filter(rule => rule instanceof dom.window.CSSMediaRule && rule.conditionText === "(max-width: 560px)")
      .flatMap(rule => [...(rule as CSSMediaRule).cssRules]);
    function last(selector: string, prop: string) {
      return phone.filter(rule => (rule as CSSStyleRule).selectorText?.split(",").map(x => x.trim()).includes(selector))
        .map(rule => (rule as CSSStyleRule).style.getPropertyValue(prop)).filter(Boolean).at(-1);
    }
    assert.equal(last(".private-shell input", "min-height"), "44px");
    assert.equal(last(".private-shell input", "min-width"), "44px");
    assert.equal(last('.private-shell input[type="checkbox"]', "width"), "44px");
    assert.equal(last('.private-shell input[type="checkbox"]', "height"), "44px");
    const row = new JSDOM(`<style>${css}</style><ul class="private-dashboard-list"><li><span><a>my mixedCase project</a></span></li></ul>`);
    try { assert.notEqual(row.window.getComputedStyle(row.window.document.querySelector("span")!).textTransform, "capitalize"); }
    finally { row.window.close(); }
    const name = "my mixedCase \u202eproject <b>";
    const catalog = new JSDOM(renderToStaticMarkup(createElement(ProjectCatalog, { state: "ready", projects: [{ ...project, title: name }] })));
    try {
      const title = catalog.window.document.querySelector("h3")!;
      assert.ok(title.querySelector("bdi")); assert.equal(title.textContent, "my mixedCase project <b>"); assert.equal(title.querySelector("b"), null);
    } finally { catalog.window.close(); }
    const home = new JSDOM(renderToStaticMarkup(createElement(HomeDashboard, { data: {
      projects: { state: "ready", value: { projects: [{ ...project, title: name }], nextCursor: null, canCreate: true,
        sources: { ordinary: "included", ideas: "not_configured" } } },
      activity: { state: "unavailable" }, attention: { state: "unavailable" }, connections: { state: "unavailable" },
    } satisfies HomeDashboardState })));
    try {
      const link = home.window.document.querySelector(`a[href="/projects/${encodeURIComponent(project.projectId)}"]`)!;
      assert.ok(link.querySelector("bdi")); assert.equal(link.textContent, "my mixedCase project <b>");
    } finally { home.window.close(); }
    const host = readFileSync(new URL("../src/web/v1/mac-local-web-process.ts", import.meta.url), "utf8");
    const standalone = host.match(/return new Response\(`(<!doctype html><html lang="en"><meta charset="utf-8">[\s\S]*?)`, \{/u)![1]!;
    const errorPage = new JSDOM(standalone);
    try {
      const a = errorPage.window.document.querySelector("a")!;
      assert.equal(a.textContent, "Return to Projects");
      const style = errorPage.window.getComputedStyle(a);
      assert.equal(style.minHeight, "44px"); assert.equal(style.minWidth, "44px"); assert.equal(style.display, "inline-flex");
    } finally { errorPage.window.close(); }
  } finally { dom.window.close(); }
});

test("R4U-16 leaving the inbox aborts a slow name read and stops traversal", async () => {
  const data = inbox();
  if (data.tasks.state !== "available") throw new Error("fixture");
  data.tasks.pages[0]!.items[0]!.task.projectId = "project:other";
  let requests = 0, signal: AbortSignal | undefined, respond: ((r: Response) => void) | undefined;
  const m = await mounted(createElement(ActionInboxPanel, { data }), (async (_input, init) => {
    requests++; signal = init?.signal ?? undefined;
    return new Promise<Response>(resolve => { respond = resolve; });
  }) as typeof fetch);
  try { assert.equal(requests, 1); }
  finally { await m.close(); }
  assert.equal(signal?.aborted, true);
  respond!(Response.json({ project }));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(requests, 1, "closing the page stops later name requests");
});

test("R4U-16 a late name reply cannot overwrite the refreshed name", async () => {
  const data = inbox(); let reads = 0, late: ((r: Response) => void) | undefined;
  const m = await mounted(createElement(ActionInboxPanel, { data }), (async () => {
    reads++;
    if (reads === 1) return new Promise<Response>(resolve => { late = resolve; });
    return Response.json({ project: { ...project, title: "renamed project" } });
  }) as typeof fetch);
  try {
    await act(async () => m.root.render(createElement(ActionInboxPanel, { data: { ...data } })));
    await settle(); assert.match(m.document.body.textContent!, /Project: renamed project/);
    await act(async () => { late!(Response.json({ project })); });
    await settle(); assert.match(m.document.body.textContent!, /Project: renamed project/);
    assert.doesNotMatch(m.document.body.textContent!, /Project: my mixedCase project/);
  } finally { await m.close(); }
});

test("R4U-16 a shrinking refreshed inbox never paints an empty out-of-range page", async () => {
  const data = inbox(); const counts: number[] = [];
  function Probe({ data }: { data: ActionInboxState }) {
    useLayoutEffect(() => { counts.push(document.querySelectorAll('ol[aria-label="Action Inbox items"] > li').length); }, [data]);
    return createElement(ActionInboxPanel, { data });
  }
  const m = await mounted(createElement(Probe, { data }), (async () => Response.json({ project })) as typeof fetch);
  try {
    for (let i = 1; i < 13; i++) await click(m, "Next page");
    if (data.tasks.state !== "available") throw new Error("fixture");
    const reduced: ActionInboxState = { ...data, tasks: { ...data.tasks, pages: [data.tasks.pages.at(-1)!] } };
    await act(async () => m.root.render(createElement(Probe, { data: reduced })));
    assert.equal(counts.at(-1), 1, "the first refreshed paint contains the remaining action");
    assert.equal(m.document.querySelector('nav[aria-label="Action Inbox pages"]'), null);
  } finally { await m.close(); }
});

test("R4U-16 project identifiers cannot pick inherited properties as display names", async () => {
  for (const projectId of ["constructor", "toString"]) {
    const data = inbox();
    if (data.tasks.state !== "available") throw new Error("fixture");
    for (const page of data.tasks.pages) for (const item of page.items) item.task.projectId = projectId;
    const m = await mounted(createElement(ActionInboxPanel, { data }), (async () => Response.json({ project: { ...project, projectId } })) as typeof fetch);
    try {
      await settle(); assert.match(m.document.body.textContent!, /Project: my mixedCase project/);
    } finally { await m.close(); }
  }
});

test("R4U-13 a dropped connection times out and releases the sign-in button for retry", async () => {
  const dom = new JSDOM(await renderLocalOwnerSignInPageV1().text(), {
    url: "http://127.0.0.1:59920/session", runScripts: "dangerously",
    beforeParse(window: Window & typeof globalThis) { Object.assign(window, { AbortSignal }); },
  } as { url: string });
  try {
    const form = dom.window.document.querySelector("form")!;
    (form.elements.namedItem("ownerCode") as HTMLInputElement).value = "a-valid-length-test-owner-code";
    const completed = new Promise<void>(resolve => {
      Object.assign(dom.window, { fetch: (_input: unknown, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => { reject(new Error("connection dropped")); resolve(); }, { once: true });
      }) });
    });
    form.dispatchEvent(new dom.window.Event("submit", { cancelable: true }));
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([completed, new Promise<void>(resolve => { deadline = setTimeout(resolve, 11_000); })]); }
    finally { clearTimeout(deadline); }
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(dom.window.document.querySelector("button")!.disabled, false);
    assert.match(dom.window.document.getElementById("message")!.textContent!, /Could not reach Control Room/);
    Object.assign(dom.window, { fetch: async () => new Response(null, { status: 401 }) });
    form.dispatchEvent(new dom.window.Event("submit", { cancelable: true }));
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.match(dom.window.document.getElementById("message")!.textContent!, /Check your owner code/);
  } finally { dom.window.close(); }
});

// Home also accepts the shared aggregate shape (r6ibfix); these tests drive the page shape.
function attentionData(count: number): HomeDashboardState & { attention: { state: "ready"; value: TaskAttentionPage } } {
  const page = inbox().tasks;
  assert.ok(page.state === "available");
  const attention = taskAttentionPageSchema.parse({ ...page.pages[0], items: page.pages[0]!.items.slice(0, count), nextCursor: null });
  return { projects: { state: "unavailable" }, activity: { state: "unavailable" },
    connections: { state: "unavailable" }, attention: { state: "ready", value: attention } };
}

test("R5A-04 attention changes announce briefly in a persistent region; identical refreshes stay silent", async () => {
  const m = await mounted(createElement(HomeDashboard, { data: attentionData(0) }), (async () => new Response(null, { status: 503 })) as typeof fetch);
  try {
    const region = m.document.querySelector('[data-field="attention-announcement"]');
    assert.ok(region, "persistent announcement exists even when empty");
    assert.equal(region.getAttribute('aria-live'), 'polite');
    assert.equal(region.textContent!.trim(), '', 'empty initial page stays silent');
    for (const count of [1, 2]) {
      await act(async () => m.root.render(createElement(HomeDashboard, { data: attentionData(count) })));
      assert.ok(m.document.querySelector('[data-field="attention-announcement"]') === region);
      assert.match(region.textContent!, new RegExp(`${count} .*need`));
      assert.equal(region.querySelector('a'), null);
      const content: string = region.innerHTML;
      for (let i = 0; i < 50; i++) await act(async () => m.root.render(createElement(HomeDashboard, { data: attentionData(count) })));
      assert.equal(region.innerHTML, content, 'unchanged refreshes do not rewrite the announcement');
    }
    const truncated = attentionData(2);
    assert.ok(truncated.attention.state === 'ready');
    truncated.attention.value.nextCursor = 'job:more';
    await act(async () => m.root.render(createElement(HomeDashboard, { data: truncated })));
    assert.match(region.textContent!, /2 or more items need/);
    const announcement: string = region.innerHTML;
    await act(async () => m.root.render(createElement(HomeDashboard, { data: { ...truncated, attention: { state: 'unavailable' } } })));
    assert.equal(region.innerHTML, announcement, 'failed read does not announce a false zero');
    const changed = attentionData(2);
    assert.ok(changed.attention.state === 'ready');
    changed.attention.value.items[0]!.task.jobId = 'job:new';
    const before = region.firstChild;
    await act(async () => m.root.render(createElement(HomeDashboard, { data: changed })));
    assert.ok(region.firstChild !== before, 'same-count replacement is announced');
    await act(async () => m.root.render(createElement(HomeDashboard, { data: attentionData(0) })));
    assert.match(region.textContent!, /Nothing needs/);
  } finally { await m.close(); }
});

function setField(m: Awaited<ReturnType<typeof mounted>>, id: string, value: string) {
  const input = m.document.getElementById(id) as HTMLInputElement;
  assert.ok(input);
  const prototype = input.tagName === 'SELECT' ? m.window.HTMLSelectElement.prototype : m.window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new m.window.Event(input.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
}

test("R5A-06 settings errors name and describe invalid fields before writes; corrected values recover", async () => {
  const settings = projectSettingsSchema.parse({ projectId: project.projectId, version: 3, eligibleWorkerKinds: null,
    maxConcurrentTasks: 2, defaultWorkerKind: null, defaultModel: null, defaultEffort: null, updatedAt: now });
  let writes = 0;
  const m = await mounted(createElement(ProjectSettingsPanel, { projectId: project.projectId }), (async (_input, init) => {
    if (init?.method === 'POST') { writes++; return Response.json({ ...settings, ...JSON.parse(String(init.body)), expectedVersion: undefined, version: 4 }); }
    return Response.json(settings);
  }) as typeof fetch);
  try {
    await settle();
    for (const value of ['25', '0', '1.5', '-1']) {
      await act(async () => setField(m, 'project-settings-max-concurrent', value));
      await click(m, 'Save settings', 50);
      assert.equal(writes, 0);
      const field = m.document.getElementById('project-settings-max-concurrent')!;
      assert.equal(field.getAttribute('aria-invalid'), 'true');
      const message = m.document.getElementById(field.getAttribute('aria-describedby')!)!;
      assert.ok(message); assert.match(message.textContent!, /whole numbers? .*1.*20/);
      assert.match(m.document.querySelector('[role="alert"]')!.textContent!, /Maximum concurrent tasks/);
    }
    await act(async () => setField(m, 'project-settings-max-concurrent', '2'));
    await act(async () => setField(m, 'project-settings-default-worker', 'codex'));
    await act(async () => setField(m, 'project-settings-default-model', 'invalid model?'));
    await click(m, 'Save settings', 50);
    assert.equal(writes, 0);
    const model = m.document.getElementById('project-settings-default-model')!;
    assert.equal(model.getAttribute('aria-invalid'), 'true');
    assert.match(m.document.getElementById(model.getAttribute('aria-describedby')!)!.textContent!, /180|identifier/);
    assert.match(m.document.querySelector('[role="alert"]')!.textContent!, /Default model/);
    await act(async () => setField(m, 'project-settings-default-model', 'provider/model-1'));
    await click(m, 'Save settings', 50);
    assert.equal(writes, 1);
    assert.match(m.document.body.textContent!, /Settings saved/);
    assert.equal(model.getAttribute('aria-invalid'), null);
    assert.equal(m.document.getElementById('project-settings-max-concurrent')!.getAttribute('aria-invalid'), null);
  } finally { await m.close(); }
});

test("R5A-07 Coordination route retains shell, skip target and navigation in loading, ready and unavailable states", async () => {
  const { origin: _origin, lifecycleEditable: _editable, ...coordinationProject } = project;
  const page = projectCoordinationPageSchema.parse({ project: coordinationProject,
    coordinationEnabled: true, coordinatorHead: { tenantId: 'tenant:test', projectId: project.projectId, version: 0, state: 'none',
      coordinatorActorType: null, coordinatorIdentityId: null, executorId: null, adapterId: null, connectorProfileDigest: null,
      executionBindingDigest: null, appointedAt: null, appointedByOwnerIdentityId: null },
    delegationPolicy: null, activeWork: [], dependencies: [], conflicts: [], attention: [], nextAction: 'appoint-coordinator',
    observedAt: now, versions: { coordinatorVersion: 0, policyVersion: 0, conflictsVersion: 0, attentionVersion: 0 }, viewerOwnerIdentityId: 'identity:owner' });
  for (const fail of [false, true]) {
    let reply: ((r: Response) => void) | undefined;
    const element = await CoordinationPage({ params: Promise.resolve({ projectId: encodeURIComponent(project.projectId) }) });
    const m = await mounted(createElement('div', {}, createElement('a', { href: '#private-main' }, 'Skip to content'), element),
      (async input => String(input).endsWith('/coordination') ? new Promise<Response>(resolve => { reply = resolve; }) : new Response(null, { status: 503 })) as typeof fetch);
    try {
      const check = () => {
        assert.equal(m.document.querySelectorAll('main').length, 1);
        assert.equal(m.document.querySelector('main')!.id, 'private-main');
        assert.equal(m.document.querySelector('main')!.getAttribute('tabindex'), '-1');
        assert.equal(m.document.querySelectorAll('h1').length, 1);
        assert.match(m.document.querySelector('h1')!.textContent!, /Coordination/i);
        assert.ok(m.document.querySelector('header nav'));
        assert.ok(m.document.querySelector('nav[aria-label="Project pages"]'));
        assert.ok(m.document.querySelector(`a[href="/projects/${encodeURIComponent(project.projectId)}"]`));
      };
      check(); assert.ok(reply, 'coordination read started');
      await act(async () => reply!(fail ? new Response(null, { status: 503 }) : Response.json(page)));
      await settle(); check();
      assert.match(m.document.body.textContent!, fail ? /unavailable|could not/i : /Appoint/);
    } finally { await m.close(); }
  }
});

function luminance(hex: string) {
  const channels = hex.slice(1).match(/../g)!.map(c => parseInt(c, 16) / 255).map(c => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4);
  return .2126 * channels[0]! + .7152 * channels[1]! + .0722 * channels[2]!;
}
function contrast(a: string, b: string) { const x = luminance(a), y = luminance(b); return (Math.max(x,y)+.05)/(Math.min(x,y)+.05); }

test("R5A-05 actual project fields and Reason boundaries clear 3:1 in light and both dark palettes", () => {
  assert.equal(contrast('#000000', '#ffffff'), 21); assert.equal(contrast('#ffffff', '#ffffff'), 1);
  for (const selector of [':root {', ':root[data-theme="dark"] {', ':root:not([data-theme="light"]) {']) {
    const start = baseCss.indexOf(selector), body = baseCss.slice(start, baseCss.indexOf('}', start));
    const lightBody = baseCss.slice(baseCss.indexOf(':root {'), baseCss.indexOf('}', baseCss.indexOf(':root {')));
    const tokens = Object.fromEntries([...`${lightBody}${body}`.matchAll(/--([\w-]+):\s*([^;]+);/gi)].map(m => [m[1], m[2]]));
    const privateToken = /--field-border:\s*([^;]+);/.exec(css)?.[1];
    if (privateToken) tokens['field-border'] = privateToken;
    const resolve = (value: string): string => value.replace(/var\(--([\w-]+)\)/g, (_all, key: string) => { assert.ok(tokens[key], `missing ${key}`); return resolve(tokens[key]!); });
    const form = renderToStaticMarkup(createElement(ProjectCreateForm, { pending: false, result: 'idle', onCreate: () => {} }));
    const dom = new JSDOM(`<style>${resolve(css)}</style><div class="private-shell"><div class="private-panel">${form}</div>${renderToStaticMarkup(createElement(OperationsControlPanel))}</div>`);
    try {
      for (const id of ['project-title', 'project-summary', 'operations-control-reason']) {
        const field = dom.window.document.getElementById(id)!;
        const style = dom.window.getComputedStyle(field);
        assert.equal(style.borderTopStyle, 'solid');
        const hex = (color: string) => '#' + color.match(/\d+/g)!.slice(0,3).map(n => Number(n).toString(16).padStart(2,'0')).join('');
        const border = hex(style.borderTopColor), inside = hex(style.backgroundColor);
        for (const adjacent of [inside, tokens.surface!]) assert.ok(contrast(border, adjacent) >= 3,
          `${selector} ${id}: ${contrast(border,adjacent).toFixed(2)}:1`);
      }
    } finally { dom.window.close(); }
  }
});

test('R5A-06 held save burst, uncertain retry and leaving mid-save preserve request discipline', async () => {
  const settings = projectSettingsSchema.parse({ projectId: project.projectId, version: 3, eligibleWorkerKinds: null,
    maxConcurrentTasks: 2, defaultWorkerKind: null, defaultModel: null, defaultEffort: null, updatedAt: now });
  const bodies: string[] = [];
  let reply: ((r: Response) => void) | undefined, fail: ((e: Error) => void) | undefined;
  const m = await mounted(createElement(ProjectSettingsPanel, { projectId: project.projectId }), (async (_input, init) => {
    if (init?.method !== 'POST') return Response.json(settings);
    bodies.push(String(init.body));
    return new Promise<Response>((resolve, reject) => { reply = resolve; fail = reject; });
  }) as typeof fetch);
  try {
    await settle();
    await click(m, 'Save settings', 50);
    assert.equal(bodies.length, 1);
    assert.ok([...m.document.querySelectorAll('button')].find(b => b.textContent === 'Saving…')!.disabled);
    await act(async () => fail!(new Error('connection dropped')));
    assert.match(m.document.querySelector('[role="alert"]')!.textContent!, /may have gone through/);
    await click(m, 'Save settings', 50);
    assert.equal(bodies.length, 2); assert.equal(bodies[1], bodies[0]);
    const { expectedVersion: _version, ...draft } = JSON.parse(bodies[1]!);
    await act(async () => reply!(Response.json({ ...settings, ...draft, version: 4 })));
    assert.match(m.document.body.textContent!, /Settings saved/);
    await click(m, 'Save settings', 50);
    assert.equal(bodies.length, 3);
    await act(async () => m.root.render(createElement('p', {}, 'Left settings')));
    await act(async () => reply!(Response.json({ ...settings, ...draft, version: 5 })));
    assert.equal(m.document.body.textContent, 'Left settings');
    assert.equal(bodies.length, 3, 'late reply never retries after leaving');
  } finally { await m.close(); }
});
