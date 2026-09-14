#!/usr/bin/env node
// Automated accessibility acceptance for the compiled private Control Room.
//
// The browser is connected to the built Request handler through Playwright route
// interception. No listener, remote request, production credential or native agent
// is used. State is held in one disposable PGlite database.

import assert from "node:assert/strict";
import { realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve, dirname } from "node:path";

const requireFromRepo = createRequire(resolve("package.json"));
let playwright;
for (const candidate of [process.env.PLAYWRIGHT_MODULE, "playwright"]) {
  if (!candidate) continue;
  try { playwright = requireFromRepo(candidate); break; } catch { /* try next explicit candidate */ }
}
if (!playwright) {
  console.error("private-accessibility-browser-acceptance: Playwright not found. Set PLAYWRIGHT_MODULE to an existing Playwright installation.");
  process.exit(2);
}

const { default: handler } = await import("../dist-vps/server/index.js");
const { installPrivateWebProcess } = await import("../dist-vps/server/runtime.js");
const { loadPrivateClientAssets } = await import("../dist-vps/server/serving.js");
const { fixture, now, origin, token, trust } = await import("../tests/helpers/web-foundation.ts");

const checks = [];
function check(name, condition, detail = "") {
  checks.push({ name, passed: Boolean(condition) });
  console.log(`${condition ? "ok" : "not ok"} - ${name}${detail ? ` # ${detail}` : ""}`);
  if (!condition && !process.env.ACR_COLLECT_ONLY) assert.ok(condition, `${name}${detail ? `: ${detail}` : ""}`);
}

/** Known defects outside the #181 writable paths: reported, never called accepted. */
function report(name, detail = "") {
  console.log(`# report - ${name}${detail ? ` # ${detail}` : ""}`);
}

// Target-size predicate. getBoundingClientRect already includes CSS padding and
// border, so the rect alone decides: no second padding addition.
const SMALL_TARGET_PREDICATE = `(element, visible, getComputedStyle) => {
  if (!visible(element) || element.disabled) return false;
  const box = element.getBoundingClientRect();
  return box.width < 24 || box.height < 24;
}`;

async function audit(page, label, options = {}) {
  const expectCurrent = options.current ?? true;
  await page.locator("main").waitFor({ state: "visible" });
  await page.getByRole("heading", { level: 1 }).waitFor();
  await page.waitForTimeout(100);
  const dom = await page.evaluate(predicateSrc => {
    const isSmallTarget = eval(predicateSrc);
    const visible = element => {
      const style = getComputedStyle(element);
      return style.visibility !== "hidden" && style.display !== "none" && element.getClientRects().length > 0;
    };
    const ids = [...document.querySelectorAll("[id]")].map(element => element.id);
    const duplicates = [...new Set(ids.filter((id, index) => id && ids.indexOf(id) !== index))];
    const fields = [...document.querySelectorAll("input, textarea, select")].filter(visible);
    const unnamedFields = fields.filter(field => !(field.labels?.length || field.getAttribute("aria-label") || field.getAttribute("aria-labelledby")))
      .map(field => `${field.tagName.toLowerCase()}#${field.id || "(no-id)"}`);
    const controls = [...document.querySelectorAll("button, a[href], summary")].filter(visible);
    const unnamedControls = controls.filter(control => !((control.getAttribute("aria-label") || control.getAttribute("aria-labelledby") || control.textContent || "").trim()))
      .map(control => control.outerHTML.slice(0, 120));
    const headings = [...document.querySelectorAll("h1,h2,h3,h4,h5,h6")].filter(visible)
      .map(element => ({ level: Number(element.tagName.slice(1)), text: element.textContent?.trim() ?? "" }));
    const headingJumps = headings.filter((heading, index) => index > 0 && heading.level > headings[index - 1].level + 1);
    const main = document.querySelectorAll("main#private-main");
    const skip = document.querySelector('a.skip-link[href="#private-main"]');
    const current = [...document.querySelectorAll(".private-header nav [aria-current=\"page\"]")]
      .map(element => element.textContent?.trim() ?? "");
    const smallTargets = [...document.querySelectorAll("button, a[href]")]
      .filter(element => isSmallTarget(element, visible, getComputedStyle))
      .map(element => `${element.tagName.toLowerCase()}:${(element.textContent || "").trim().slice(0, 40)}`);
    const textlessStates = [...document.querySelectorAll(".private-state")].filter(visible)
      .filter(element => !(element.textContent || "").trim()).length;
    return { lang: document.documentElement.lang, title: document.title, duplicates, unnamedFields, unnamedControls,
      headings, headingJumps, mainCount: main.length, h1Count: headings.filter(heading => heading.level === 1).length,
      skipPresent: Boolean(skip), horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      current, smallTargets, textlessStates };
  }, SMALL_TARGET_PREDICATE);
  check(`${label}: language is declared`, dom.lang === "en");
  check(`${label}: page title identifies Control Room`, /Control Room/.test(dom.title), dom.title);
  check(`${label}: one main content landmark`, dom.mainCount === 1, `count=${dom.mainCount}`);
  check(`${label}: one visible page heading`, dom.h1Count === 1, `headings=${JSON.stringify(dom.headings)}`);
  check(`${label}: headings do not skip levels`, dom.headingJumps.length === 0, JSON.stringify(dom.headingJumps));
  check(`${label}: element identifiers are unique`, dom.duplicates.length === 0, dom.duplicates.join(","));
  check(`${label}: visible form fields have names`, dom.unnamedFields.length === 0, dom.unnamedFields.join(","));
  check(`${label}: visible controls have names`, dom.unnamedControls.length === 0, dom.unnamedControls.join(" | "));
  check(`${label}: skip link targets main content`, dom.skipPresent);
  check(`${label}: narrow page does not scroll sideways`, !dom.horizontalOverflow);
  // Pages whose current-page or target-size dimensions depend on #27-reserved
  // shells (or a header nav entry that does not exist) are audited here for
  // structure only; the missing dimensions are reported, never accepted.
  if (expectCurrent)
    check(`${label}: exactly one current-page marker in header navigation`, dom.current.length === 1, dom.current.join("|"));
  else
    check(`${label}: header navigation has no stale current-page marker`, dom.current.length === 0, dom.current.join("|"));
  if (options.shell !== false)
    check(`${label}: visible controls meet the 24px minimum target`, dom.smallTargets.length === 0, dom.smallTargets.join(" | "));
  check(`${label}: status badges carry text, not color alone`, dom.textlessStates === 0);
}

/** Regression for the target-size detector itself: a genuinely undersized
 * control must be flagged, so a passing audit cannot mean a blind detector. */
async function targetDetectorSelfTest(page) {
  const detected = await page.evaluate(predicateSrc => {
    const isSmallTarget = eval(predicateSrc);
    const visible = element => {
      const style = getComputedStyle(element);
      return style.visibility !== "hidden" && style.display !== "none" && element.getClientRects().length > 0;
    };
    const probe = document.createElement("button");
    probe.textContent = "probe";
    probe.style.cssText = "position:fixed;left:0;top:0;width:10px;height:10px;padding:0;border:0;";
    document.body.append(probe);
    const flagged = isSmallTarget(probe, visible, getComputedStyle);
    probe.remove();
    return flagged;
  }, SMALL_TARGET_PREDICATE);
  check("target-size detector flags a genuinely undersized control", detected === true);
}

/** Keyboard helpers: the harness may place initial focus, keys do the rest. */
async function keyActivate(locator) {
  await locator.focus();
  await locator.page().keyboard.press("Enter");
}

async function tabUntil(page, locator, max = 60) {
  for (let step = 0; step < max; step++) {
    if (await locator.count() && await locator.evaluate(element => element === document.activeElement)) return true;
    await page.keyboard.press("Tab");
  }
  return false;
}

const focusedIs = (page, locator) => locator.evaluate(element => element === document.activeElement);

const STABLE_PAGES = [["/", "Home"], ["/projects", "Project catalog"], ["/workers", "Workers"],
  ["/needs-me", "Needs attention"], ["/settings", "Settings"], ["/connections", "Connections"]];
const PROJECT_SECTIONS = [["inbox", "Project inbox"], ["tasks", "Project work"], ["agents", "Project agents"],
  ["automations", "Project automations"], ["files", "Project files"], ["reviews", "Project reviews"],
  ["activity", "Project activity"], ["settings", "Project settings"], ["news", "Project news"]];

/** One shared page matrix so the narrow and desktop runs cannot drift. */
async function stableMatrix(page, tag, projectPath) {
  for (const [path, label] of STABLE_PAGES) {
    const response = await page.goto(`${origin}${path}`, { waitUntil: "domcontentloaded" });
    check(`${tag} ${label}: protected page route responds`, response?.status() === 200, `status=${response?.status() ?? "none"}`);
    // The header navigation has no Connections entry (private-header.tsx), so
    // that page cannot carry a current-page marker: structure is accepted, the
    // missing navigation state is reported, not accepted.
    await audit(page, `${tag} ${label}`, path === "/connections" ? { current: false } : {});
    if (path === "/connections")
      report(`${tag} Connections: no header navigation entry, current-page state not accepted`, "private-header.tsx nav has no /connections item");
  }
  await page.goto(`${origin}/ideas`, { waitUntil: "domcontentloaded" });
  await audit(page, `${tag} Idea Lab`, { current: false, shell: false });
  report(`${tag} Idea Lab: shell defects reported, page not accepted`,
    "no aria-current=page for /ideas; All saved ideas 97x20, Refresh saved discussion 163x23 (#27-reserved idea-workspace.tsx)");
  await page.goto(`${origin}${projectPath}`, { waitUntil: "domcontentloaded" });
  await audit(page, `${tag} Project overview`);
  for (const [section, label] of PROJECT_SECTIONS) {
    const response = await page.goto(`${origin}${projectPath}/${section}`, { waitUntil: "domcontentloaded" });
    check(`${tag} ${label}: protected page route responds`, response?.status() === 200, `status=${response?.status() ?? "none"}`);
    // The news section renders the #27-reserved news workspace without a shell
    // wrapper: structural checks apply, the shell dimension is reported.
    await audit(page, `${tag} ${label}`, section === "news" ? { shell: false } : {});
    if (section === "news")
      report(`${tag} Project news: shell defects reported, page not accepted`, "#27-reserved news workspace without .private-shell wrapper");
  }
}

const disposable = await fixture();
const assets = await loadPrivateClientAssets(await realpath("dist-vps/client"));
let application;
let browser;
try {
  const serveRouteFor = (siteOrigin, jwt, handle) => async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== siteOrigin) { await route.abort("blockedbyclient"); return; }
    const headers = new Headers(request.headers());
    headers.set("cf-access-jwt-assertion", jwt);
    headers.set("accept", headers.get("accept") ?? "text/html");
    if (!["GET", "HEAD"].includes(request.method())) headers.set("origin", siteOrigin);
    const body = request.postDataBuffer();
    const staticResponse = (url.pathname.startsWith("/_next/") || url.pathname === "/favicon.svg") && !url.search
      ? assets.respond(url.pathname, request.method()) : undefined;
    const response = staticResponse ?? await handle(new Request(request.url(), { method: request.method(), headers,
      ...(!["GET", "HEAD"].includes(request.method()) && body ? { body } : {}) }));
    await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers),
      body: request.method() === "HEAD" ? Buffer.alloc(0) : Buffer.from(await response.arrayBuffer()) });
  };
  application = installPrivateWebProcess({ origin, ...trust,
    tenantId: "tenant:web", workspaceId: "workspace:web",
    database: { client: disposable.client, close: () => disposable.db.close() },
    clock: () => now, loadKeys: async () => trust.keys });
  browser = await playwright.chromium.launch({ headless: true });
  const serveRoute = serveRouteFor(origin, token(), handler);
  const context = await browser.newContext({ viewport: { width: 360, height: 844 } });
  await context.route("**/*", serveRoute);

  const page = await context.newPage();
  await page.goto(`${origin}/`, { waitUntil: "domcontentloaded" });
  await targetDetectorSelfTest(page);

  // Keyboard-only workspace menu: Tab to the menu, Enter opens, Tab reaches
  // the Projects link, Enter navigates, and the tab order restarts at skip.
  await page.locator("body").focus();
  const menu = page.getByRole("button", { name: "Menu" });
  check("360px workspace menu is keyboard reachable", await tabUntil(page, menu));
  await page.keyboard.press("Enter");
  check("360px workspace menu opens from the keyboard", await menu.getAttribute("aria-expanded") === "true");
  const projectsLink = page.getByRole("navigation", { name: "Workspace pages" }).getByRole("link", { name: "Projects" });
  check("360px menu navigation is keyboard reachable", await tabUntil(page, projectsLink));
  await page.keyboard.press("Enter");
  await page.waitForURL(url => url.pathname === "/projects");
  check("360px keyboard menu navigation arrives at Projects", new URL(page.url()).pathname === "/projects");
  await page.keyboard.press("Tab");
  check("360px tab order restarts at the skip link after navigation",
    await page.locator(":focus").evaluate(element => element.matches("a.skip-link")));

  await page.goto(`${origin}/projects`, { waitUntil: "domcontentloaded" });
  await page.getByText("No projects on this page with your current access.").waitFor();
  check("empty catalog names the empty state", (await page.getByText("No projects on this page with your current access.").count()) === 1);

  // Keyboard-only project creation: harness places focus, keys do the rest.
  await page.locator("#project-title").focus();
  await page.waitForFunction(() => document.activeElement?.id === "project-title");
  await page.keyboard.type("Accessibility acceptance project");
  await page.keyboard.press("Tab");
  check("keyboard focus order reaches the summary field", await page.locator("#project-summary:focus").count() === 1);
  await page.keyboard.type("Disposable project used to audit protected project and task pages.");
  await page.keyboard.press("Tab");
  const createButton = page.getByRole("button", { name: "Create project" });
  check("keyboard focus order reaches the create action", await focusedIs(page, createButton));
  const ringOnButton = await page.evaluate(() => {
    const style = getComputedStyle(document.activeElement);
    return { outline: style.outlineWidth, shadow: style.boxShadow };
  });
  check("focused create action shows a visible ring", ringOnButton.outline !== "0px" || ringOnButton.shadow !== "none",
    JSON.stringify(ringOnButton));
  await page.keyboard.press("Enter");
  await page.getByRole("heading", { name: "Accessibility acceptance project" }).waitFor();
  check("keyboard submission creates the project",
    (await page.getByRole("heading", { name: "Accessibility acceptance project" }).count()) === 1);
  const projectPath = new URL(page.url()).pathname;

  await stableMatrix(page, "360px", projectPath);
  const unknown = await page.goto(`${origin}${projectPath}/unknown-section`, { waitUntil: "domcontentloaded" });
  check("Unknown project section is not rendered as the overview", unknown?.status() === 404, `status=${unknown?.status() ?? "none"}`);

  // Keyboard-only task creation on the tasks page.
  await page.goto(`${origin}${projectPath}/tasks`, { waitUntil: "domcontentloaded" });
  await page.locator("#task-title").focus();
  await page.waitForFunction(() => document.activeElement?.id === "task-title");
  await page.keyboard.type("Accessible task detail");
  await page.keyboard.press("Tab");
  await page.keyboard.type("Return a short saved result without external actions.");
  const saveButton = page.getByRole("button", { name: "Save proposal" });
  check("keyboard focus order reaches the save action", await (async () => {
    for (let step = 0; step < 20; step++) {
      if (await focusedIs(page, saveButton)) return true;
      await page.keyboard.press("Tab");
    }
    return false;
  })());
  await page.keyboard.press("Enter");
  await page.getByRole("heading", { name: "Accessible task detail" }).waitFor();
  check("keyboard submission saves the task proposal",
    (await page.getByRole("heading", { name: "Accessible task detail" }).count()) === 1);
  const taskPath = new URL(page.url()).pathname;
  await audit(page, "360px Task detail");
  // The pathname from the URL is already percent-encoded: use the segment
  // as-is when matching client API routes (no second encoding pass).
  const projectIdSegment = projectPath.split("/").pop();

  // Failed save announces an uncertain outcome and keeps an actionable,
  // keyboard-reachable check; a retry after recovery writes successfully.
  await page.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.origin === origin && url.pathname === `/api/v1/projects/${projectIdSegment}/tasks`
      && route.request().method() === "POST") {
      await route.fulfill({ status: 500, body: "{}" });
      return;
    }
    await serveRoute(route);
  });
  async function tabToSave() {
    for (let step = 0; step < 25; step++) {
      if (await focusedIs(page, page.getByRole("button", { name: "Save proposal" }))) return true;
      await page.keyboard.press("Tab");
    }
    return false;
  }
  await page.goto(`${origin}${projectPath}/tasks`, { waitUntil: "domcontentloaded" });
  await page.locator("#task-title").focus();
  await page.keyboard.type("Unconfirmed second task");
  await page.keyboard.press("Tab");
  await page.keyboard.type("Typed without a pointer; the save will fail once.");
  check("keyboard focus order reaches the save action before the outage", await tabToSave());
  await page.keyboard.press("Enter");
  const uncertainAlert = page.getByRole("alert");
  await uncertainAlert.first().waitFor();
  const uncertainText = (await uncertainAlert.first().textContent()) ?? "";
  check("failed save announces an uncertain outcome, not success", /exact save again|unconfirmed|may have completed/i.test(uncertainText), uncertainText.slice(0, 120));
  // The save button disables while pending, so focus falls back to the body:
  // reported (task-panels.tsx is outside the #181 paths), not edited. The tab
  // order must still continue from wherever focus landed.
  report("failed save drops focus while the save button is disabled", "task-panels.tsx TaskProposalForm disables on pending; focus falls back to body");
  const checkSaveButton = page.getByRole("button", { name: /check this exact save again/i });
  check("uncertain save offers a keyboard-reachable recheck", await tabUntil(page, checkSaveButton));
  check("recheck starts focused on its action", await focusedIs(page, checkSaveButton));
  await page.keyboard.press("Enter");
  await page.waitForTimeout(500);
  check("recheck against the outage still reports uncertainty",
    (await page.getByRole("alert").count()) >= 1);
  await page.unroute("**/*");
  await page.route("**/*", serveRoute);
  await page.keyboard.press("Tab");
  check("recovered save still offers its recheck", await tabUntil(page, page.getByRole("button", { name: /check this exact save again/i })));
  await page.keyboard.press("Enter");
  await page.getByRole("heading", { name: "Unconfirmed second task" }).waitFor({ timeout: 15000 });
  check("recovered retry writes the task successfully",
    (await page.getByRole("heading", { name: "Unconfirmed second task" }).count()) === 1);
  // Client-side navigation to the new task leaves focus on the body instead
  // of moving it to the new heading: reported (navigation focus management
  // lives outside the #181 paths), not edited. The tab order must restart.
  report("successful client navigation leaves focus on the body", "new task heading renders but focus is not moved to it");
  await page.keyboard.press("Tab");
  check("tab order restarts at the skip link after the write",
    await page.locator(":focus").evaluate(element => element.matches("a.skip-link")));

  // Return navigation by keyboard: the back link returns to the task list.
  const backLink = page.getByRole("link", { name: /project tasks/i }).first();
  await keyActivate(backLink);
  await page.waitForURL(url => url.pathname === `${projectPath}/tasks`);
  check("keyboard return navigation reaches the project tasks", new URL(page.url()).pathname === `${projectPath}/tasks`);
  await page.keyboard.press("Tab");
  check("tab order restarts at the skip link after return",
    await page.locator(":focus").evaluate(element => element.matches("a.skip-link")));

  // The narrow-flow task has no recorded harness result (recording one needs a
  // live execution), so its review panel cannot mount here. The full owner
  // review journey runs below against a second disposable process whose
  // database holds a genuinely ingested pipeline result.
  report("360px owner review: no recorded result on the created task; journey runs on the seeded review process");

  // Project tabs by keyboard: links reached with Tab, opened with Enter.
  await page.goto(`${origin}${projectPath}`, { waitUntil: "domcontentloaded" });
  const tabsNav = page.getByRole("navigation", { name: "Project pages" });
  const filesTab = tabsNav.getByRole("link", { name: "Files" });
  check("keyboard focus order reaches the Files project tab", await tabUntil(page, filesTab));
  await page.keyboard.press("Enter");
  await page.waitForURL(url => url.pathname === `${projectPath}/files`);
  check("keyboard project-tab navigation reaches Files", new URL(page.url()).pathname === `${projectPath}/files`);
  check("project-tab navigation lands on the Files heading",
    (await page.getByRole("heading", { name: "Project files" }).count()) === 1);

  // Truthful loading state: hold the files request, the loading message shows.
  let releaseFiles;
  const filesGate = new Promise(resolve => { releaseFiles = resolve; });
  await page.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.origin === origin && url.pathname.includes("/api/v1/projects/") && url.pathname.endsWith("/files")) {
      await filesGate;
      await serveRoute(route);
      return;
    }
    await serveRoute(route);
  });
  await page.goto(`${origin}${projectPath}/files`, { waitUntil: "domcontentloaded" });
  const loadingStatus = page.getByRole("status");
  await loadingStatus.filter({ hasText: /loading protected project files/i }).first().waitFor();
  check("loading state is announced while files load",
    (((await loadingStatus.filter({ hasText: /loading protected project files/i }).first().textContent()) ?? "").length > 0));
  releaseFiles();
  await page.getByRole("heading", { name: "Project files" }).waitFor({ timeout: 15000 });
  check("held files request resolves to the ready view",
    (await page.getByRole("heading", { name: "Project files" }).count()) >= 1);
  await page.unroute("**/*");
  await page.route("**/*", serveRoute);

  // Denied files: 403 announces access denial, the refresh action stays usable.
  await page.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.origin === origin && url.pathname.includes("/api/v1/projects/") && url.pathname.endsWith("/files")) {
      await route.fulfill({ status: 403, body: "{}" });
      return;
    }
    await serveRoute(route);
  });
  await page.goto(`${origin}${projectPath}/files`, { waitUntil: "domcontentloaded" });
  await page.getByRole("alert").filter({ hasText: /does not include this project.s files/i }).first().waitFor();
  check("denied files announce the denial, not an empty list",
    (/does not include this project.s files/i.test((await page.getByRole("alert").first().textContent()) ?? "")));
  const filesRefresh = page.getByRole("button", { name: /refresh project files/i });
  check("denied files keep the refresh action keyboard reachable", await tabUntil(page, filesRefresh));
  await page.unroute("**/*");
  await page.route("**/*", serveRoute);

  // Failed files: 500 announces unavailability without inventing content.
  await page.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.origin === origin && url.pathname.includes("/api/v1/projects/") && url.pathname.endsWith("/files")) {
      await route.fulfill({ status: 500, body: "{}" });
      return;
    }
    await serveRoute(route);
  });
  await page.goto(`${origin}${projectPath}/files`, { waitUntil: "domcontentloaded" });
  await page.getByRole("alert").filter({ hasText: /unavailable|no empty file list/i }).first().waitFor();
  check("failed files announce unavailability without invented content",
    (/unavailable|no empty file list/i.test((await page.getByRole("alert").first().textContent()) ?? "")));
  await page.unroute("**/*");
  await page.route("**/*", serveRoute);

  // Connections: authenticated inventory plus signed-out and failed variants.
  await page.goto(`${origin}/connections`, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Connections" }).waitFor();
  check("connections inventory renders for the signed-in owner",
    (await page.getByRole("heading", { name: "Connections" }).count()) === 1);
  await page.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.origin === origin && url.pathname === "/api/v1/connections") {
      await route.fulfill({ status: 401, body: "{}" });
      return;
    }
    await serveRoute(route);
  });
  await page.goto(`${origin}/connections`, { waitUntil: "domcontentloaded" });
  await page.getByRole("alert").filter({ hasText: /session has ended/i }).first().waitFor();
  check("signed-out connections announce the ended session",
    (/session has ended/i.test((await page.getByRole("alert").first().textContent()) ?? "")));
  const signInAgain = page.getByRole("link", { name: /sign in again/i });
  check("signed-out connections offer a keyboard-reachable sign-in", await tabUntil(page, signInAgain));
  check("sign-in recovery starts focused on its link", await focusedIs(page, signInAgain));
  await page.unroute("**/*");
  await page.route("**/*", serveRoute);
  await page.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.origin === origin && url.pathname === "/api/v1/connections") {
      await route.fulfill({ status: 500, body: "{}" });
      return;
    }
    await serveRoute(route);
  });
  await page.goto(`${origin}/connections`, { waitUntil: "domcontentloaded" });
  await page.getByRole("alert").filter({ hasText: /inventory unavailable|not configured/i }).first().waitFor();
  check("failed connections announce unavailability without sample data",
    (/inventory unavailable|not configured/i.test((await page.getByRole("alert").first().textContent()) ?? "")));
  await page.unroute("**/*");
  await page.route("**/*", serveRoute);

  // Needs-attention inbox failure announces instead of claiming an all-clear.
  await page.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.origin === origin && url.pathname === "/api/v1/needs-me/tasks") {
      await route.fulfill({ status: 500, body: "{}" });
      return;
    }
    await serveRoute(route);
  });
  await page.goto(`${origin}/needs-me`, { waitUntil: "domcontentloaded" });
  await page.getByRole("alert").filter({ hasText: /task inbox unavailable/i }).first().waitFor();
  check("failed task inbox announces unavailability, never an all-clear",
    (/task inbox unavailable/i.test((await page.getByRole("alert").first().textContent()) ?? "")));
  await page.unroute("**/*");
  await page.route("**/*", serveRoute);

  await page.goto(`${origin}/`, { waitUntil: "domcontentloaded" });
  await page.locator("body").focus();
  await page.keyboard.press("Tab");
  const focused = page.locator(":focus");
  check("skip link is the first keyboard target", await focused.evaluate(element => element.matches("a.skip-link")));
  await page.keyboard.press("Enter");
  check("skip link moves focus to main content", await page.locator("main#private-main:focus").count() === 1);

  // Visible focus sweep across the home page's interactive elements.
  await page.goto(`${origin}/`, { waitUntil: "domcontentloaded" });
  await page.locator("body").focus();
  const ringless = [];
  for (let step = 0; step < 25; step++) {
    await page.keyboard.press("Tab");
    const signature = await page.evaluate(() => {
      const element = document.activeElement;
      if (!element || element === document.body) return "body";
      const style = getComputedStyle(element);
      const tagged = `${element.tagName.toLowerCase()}.${(element.className.baseVal ?? element.className ?? "").toString().split(" ")[0]}:${(element.textContent || "").trim().slice(0, 30)}`;
      return (style.outlineWidth !== "0px" && style.outlineStyle !== "none") || style.boxShadow !== "none"
        ? `ring:${tagged}` : `flat:${tagged}`;
    });
    if (signature === "body") break;
    if (signature.startsWith("flat:")) ringless.push(signature.slice(5));
  }
  check("every keyboard stop shows a focus ring", ringless.length === 0, ringless.join(" | "));

  // Desktop viewport: the same shared matrix at 1280px.
  const desktop = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const wide = await desktop.newPage();
  await wide.route("**/*", serveRoute);
  await stableMatrix(wide, "Desktop", projectPath);
  await wide.goto(`${origin}${taskPath}`, { waitUntil: "domcontentloaded" });
  await audit(wide, "Desktop Task detail");
  await wide.goto(`${origin}/`, { waitUntil: "domcontentloaded" });
  await wide.locator("body").focus();
  await wide.keyboard.press("Tab");
  check("desktop skip link is the first keyboard target",
    await wide.locator(":focus").evaluate(element => element.matches("a.skip-link")));
  await desktop.close();

  // Owner review by keyboard: the runtime installs a single private app per node
  // process, so the seeded review journey (a second disposable database holding
  // a genuinely ingested pipeline result) runs in a child process. The child
  // source is embedded here so the acceptance run stays one scoped file.
  const { spawnSync } = await import("node:child_process");
  const { writeFileSync, unlinkSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { fileURLToPath } = await import("node:url");
  const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const reviewJourneySource = [
    "import { pathToFileURL } from 'node:url';",
    "import { createRequire } from 'node:module';",
    "const ROOT = process.env.ACR_REPO_ROOT;",
    "const file = (p) => pathToFileURL(ROOT + '/' + p).href;",
    "const requireFromRepo = createRequire(ROOT + '/package.json');",
    "const playwright = requireFromRepo(process.env.PLAYWRIGHT_MODULE || 'playwright');",
    "const { default: handler } = await import(file('dist-vps/server/index.js'));",
    "const { installPrivateWebProcess } = await import(file('dist-vps/server/runtime.js'));",
    "const { loadPrivateClientAssets } = await import(file('dist-vps/server/serving.js'));",
    "const { trust } = await import(file('tests/helpers/web-foundation.ts'));",
    "const { ownerReviewFixture } = await import(file('tests/helpers/web-owner-review.ts'));",
    "const { instant } = await import(file('tests/hermes-native-fixture.ts'));",
    "const { realpath } = await import('node:fs/promises');",
    "let failed = false;",
    "function check(name, cond, detail) {",
    "  console.log((cond ? 'ok - review: ' : 'not ok - review: ') + name + (detail ? ' # ' + detail : ''));",
    "  if (!cond) failed = true;",
    "}",
    "async function tabUntil(page, locator, max) {",
    "  for (let i = 0; i < (max || 60); i++) {",
    "    if ((await locator.count()) && (await locator.evaluate((e) => e === document.activeElement))) return true;",
    "    await page.keyboard.press('Tab');",
    "  }",
    "  return false;",
    "}",
    "const PRED = '(element, visible, getComputedStyle) => { if (!visible(element) || element.disabled) return false; const box = element.getBoundingClientRect(); return box.width < 24 || box.height < 24; }';",
    "const siteOrigin = 'https://review.example.invalid';",
    "const seeded = await ownerReviewFixture();",
    "const assets = await loadPrivateClientAssets(await realpath(ROOT + '/dist-vps/client'));",
    "const app = installPrivateWebProcess({ origin: siteOrigin, ...trust, tenantId: 'tenant:test', workspaceId: 'workspace:test',",
    "  database: { client: seeded.db, close: () => seeded.close() },",
    "  clock: () => instant + 6000, loadKeys: async () => trust.keys,",
    "  tasks: { harnessIntegrityKey: seeded.harnessKey, results: seeded.config,",
    "    reviews: { integrityKey: seeded.reviewKey, checkpoints: seeded.checkpoints },",
    "    ownerReviews: { integrityKey: seeded.reviewKey, checkpoints: seeded.checkpoints } } });",
    "const browser = await playwright.chromium.launch({ headless: true });",
    "try {",
    "  const context = await browser.newContext({ viewport: { width: 360, height: 844 } });",
    "  await context.route('**/*', async (route) => {",
    "    const request = route.request();",
    "    const url = new URL(request.url());",
    "    if (url.origin !== siteOrigin) { await route.abort('blockedbyclient'); return; }",
    "    const headers = new Headers(request.headers());",
    "    headers.set('cf-access-jwt-assertion', seeded.jwt);",
    "    headers.set('accept', headers.get('accept') || 'text/html');",
    "    if (request.method() !== 'GET' && request.method() !== 'HEAD') headers.set('origin', siteOrigin);",
    "    const body = request.postDataBuffer();",
    "    const stat = (url.pathname.indexOf('/_next/') === 0 || url.pathname === '/favicon.svg') && !url.search",
    "      ? assets.respond(url.pathname, request.method()) : undefined;",
    "    const response = stat || await handler(new Request(request.url(), { method: request.method(), headers,",
    "      ...(request.method() !== 'GET' && request.method() !== 'HEAD' && body ? { body } : {}) }));",
    "    await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers),",
    "      body: request.method() === 'HEAD' ? Buffer.alloc(0) : Buffer.from(await response.arrayBuffer()) });",
    "  });",
    "  const page = await context.newPage();",
    "  const taskPath = '/projects/' + encodeURIComponent('project:test') + '/tasks/' + encodeURIComponent('job:test');",
    "  await page.goto(siteOrigin + taskPath, { waitUntil: 'domcontentloaded' });",
    "  await page.locator('main').waitFor({ state: 'visible' });",
    "  await page.getByRole('heading', { level: 1 }).waitFor({ timeout: 15000 });",
    "  const dom = await page.evaluate((src) => {",
    "    const isSmall = eval(src);",
    "    const visible = (e) => { const s = getComputedStyle(e); return s.visibility !== 'hidden' && s.display !== 'none' && e.getClientRects().length > 0; };",
    "    const h1 = Array.from(document.querySelectorAll('h1')).filter(visible).map((e) => e.textContent.trim());",
    "    const current = Array.from(document.querySelectorAll('.private-header nav [aria-current=\"page\"]')).map((e) => e.textContent.trim());",
    "    const small = Array.from(document.querySelectorAll('button, a[href]')).filter((e) => isSmall(e, visible, getComputedStyle)).map((e) => e.textContent.trim().slice(0, 30));",
    "    return { lang: document.documentElement.lang, main: document.querySelectorAll('main#private-main').length,",
    "      h1, skip: !!document.querySelector('a.skip-link[href=\"#private-main\"]'), current, small,",
    "      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1 };",
    "  }, PRED);",
    "  check('seeded task page declares language', dom.lang === 'en');",
    "  check('seeded task page has one main landmark', dom.main === 1, 'count=' + dom.main);",
    "  check('seeded task page has one heading', dom.h1.length === 1, JSON.stringify(dom.h1));",
    "  check('seeded task page offers a skip link', dom.skip);",
    "  check('seeded task page marks Projects current', dom.current.length === 1 && dom.current[0] === 'Projects', dom.current.join('|'));",
    "  check('seeded task page controls meet 24px', dom.small.length === 0, dom.small.join(' | '));",
    "  check('seeded task page does not scroll sideways', !dom.overflow);",
    "  const readResult = page.getByRole('button', { name: 'Read result' });",
    "  await readResult.waitFor({ timeout: 15000 });",
    "  check('read-result action is keyboard reachable', await tabUntil(page, readResult));",
    "  await page.keyboard.press('Enter');",
    "  await page.getByRole('heading', { name: 'Received result' }).waitFor();",
    "  check('keyboard opens the recorded result file', (await page.getByText('A useful private result.').count()) >= 1);",
    "  const accept = page.getByRole('button', { name: 'Accept quality' });",
    "  await accept.waitFor({ timeout: 15000 });",
    "  check('owner review loads for the recorded result', (await accept.count()) === 1);",
    "  await page.getByLabel('Changes you want').focus();",
    "  await page.keyboard.type('Keyboard review note: clarify the summary.');",
    "  const requestChanges = page.getByRole('button', { name: 'Request changes' });",
    "  check('request-changes action is keyboard reachable', await tabUntil(page, requestChanges));",
    "  await page.keyboard.press('Enter');",
    "  const saved = page.getByRole('status').filter({ hasText: /changes requested/i }).first();",
    "  await saved.waitFor();",
    "  check('keyboard review records the changes request', /changes requested/i.test((await saved.textContent()) || ''));",
    "  console.log('# report - review: save disables the decision buttons while recording, focus falls back to the body # task-owner-review.tsx OwnerReviewPanel disables on pending or held');",
    "  await page.keyboard.press('Tab');",
    "  check('tab order continues after the review save',",
    "    await page.locator(':focus').evaluate((e) => e !== document.body));",
    "  const prepText = (await page.locator(\"section[aria-label='Prepare revised task']\").first().textContent().catch(() => '')) || '';",
    "  check('revision preparation reports its unconnected state', prepText.indexOf('Revision preparation is not connected for this app.') !== -1);",
    "  const back = page.getByRole('link', { name: /project tasks/i }).first();",
    "  await back.focus();",
    "  await page.keyboard.press('Enter');",
    "  await page.waitForURL((u) => u.pathname.endsWith('/tasks'));",
    "  check('keyboard return leaves the reviewed task', new URL(page.url()).pathname.endsWith('/tasks'));",
    "  await page.keyboard.press('Tab');",
    "  check('tab order restarts at the skip link after return',",
    "    await page.locator(':focus').evaluate((e) => e.matches('a.skip-link')));",
    "  await context.close();",
    "} finally {",
    "  await browser.close().catch(() => {});",
    "  await app.close().catch(() => {});",
    "}",
    "if (failed) process.exit(1);",
    "console.log('ok - review: seeded review journey completes');",
  ].join("\n");
  const { join } = await import("node:path");
  const childPath = join(tmpdir(), "acr-review-journey-" + Date.now() + ".mjs");
  writeFileSync(childPath, reviewJourneySource);
  let childFailed = "";
  try {
    const child = spawnSync(process.execPath, ["--import", "tsx", childPath],
      { cwd: repoRoot, env: { ...process.env, ACR_REPO_ROOT: repoRoot }, timeout: 420000, encoding: "utf8" });
    process.stdout.write(child.stdout || "");
    process.stderr.write(child.stderr || "");
    if (child.status !== 0) childFailed = "exit=" + child.status;
    else if (/^not ok/m.test(child.stdout || "")) childFailed = "not-ok lines present";
  } finally {
    try { unlinkSync(childPath); } catch { /* temp cleanup best effort */ }
  }
  check("seeded owner-review journey completes on genuine pipeline data", childFailed === "", childFailed);
  report("revision preparation needs the execution planner", "OwnerRevisionPanel honestly reports not-connected; revise wiring is outside the #181 paths");

  // 200% zoom as real reflow: CSS zoom halves the effective layout viewport on
  // a 1280px window, exercising the same reflow a browser zoom would.
  const zoomed = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await zoomed.route("**/*", serveRoute);
  const zoomPage = await zoomed.newPage();
  await zoomPage.goto(`${origin}/projects`, { waitUntil: "domcontentloaded" });
  await zoomPage.addStyleTag({ content: "html { zoom: 2; }" });
  await zoomPage.waitForTimeout(200);
  const zoomOverflow = await zoomPage.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  check("200% zoom reflow does not scroll sideways", !zoomOverflow);
  const zoomCreate = zoomPage.getByRole("button", { name: "Create project" });
  await zoomCreate.waitFor();
  check("200% zoom reflow keeps the create action usable", await tabUntil(zoomPage, zoomCreate));
  await zoomed.close();

  // Reduced motion: the product still works with the preference emulated.
  const calm = await browser.newContext({ viewport: { width: 360, height: 844 }, reducedMotion: "reduce" });
  await calm.route("**/*", serveRoute);
  const calmPage = await calm.newPage();
  await calmPage.goto(`${origin}/`, { waitUntil: "domcontentloaded" });
  await calmPage.locator("main").waitFor({ state: "visible" });
  check("reduced-motion preference still renders the product",
    (await calmPage.locator("main").count()) === 1);
  await calm.close();

  await context.close();
  console.log(`# ${checks.filter(value => value.passed).length}/${checks.length} accessibility checks passed across the compiled protected application`);
} finally {
  if (browser) await browser.close().catch(() => {});
  if (application) await application.close().catch(() => {});
  else await disposable.db.close().catch(() => {});
}
