#!/usr/bin/env node
// Browser acceptance for the compiled private Control Room application.
//
// The browser is connected to the built Request handler through Playwright route
// interception. No TCP listener, production configuration, credential, remote
// request or native agent is used. All state lives in a disposable PGlite database.
//
// Usage:
//   pnpm build
//   PLAYWRIGHT_MODULE=/absolute/path/to/playwright \
//     node --import tsx scripts/private-browser-acceptance.mjs

import assert from "node:assert/strict";
import { mkdir, readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { isAbsolute, resolve, sep } from "node:path";

const requireFromRepo = createRequire(resolve("package.json"));
let playwright;
for (const candidate of [process.env.PLAYWRIGHT_MODULE, "playwright"]) {
  if (!candidate) continue;
  try { playwright = requireFromRepo(candidate); break; } catch { /* try the next explicit candidate */ }
}
if (!playwright) {
  console.error("private-browser-acceptance: Playwright not found. Set PLAYWRIGHT_MODULE to an existing Playwright installation.");
  process.exit(2);
}

// Screenshots are opt-in: the operator supplies an absolute destination, so a
// normal acceptance run never writes evidence into this checkout.
const requestedScreenshotDirectory = process.env.PRIVATE_BROWSER_SCREENSHOT_DIR;
let screenshotDirectory;
if (requestedScreenshotDirectory) {
  assert.ok(isAbsolute(requestedScreenshotDirectory), "PRIVATE_BROWSER_SCREENSHOT_DIR must be an absolute path");
  await mkdir(requestedScreenshotDirectory, { recursive: true });
  screenshotDirectory = await realpath(requestedScreenshotDirectory);
  console.log("# saving synthetic screenshots to the operator-supplied directory");
}

const { default: handler } = await import("../dist-vps/server/index.js");
const { installPrivateWebProcess } = await import("../dist-vps/server/runtime.js");
const { loadPrivateClientAssets } = await import("../dist-vps/server/serving.js");
const { fixture, now, origin, token, trust } = await import("../tests/helpers/web-foundation.ts");

const checks = [];
function check(name, condition, detail = "") {
  checks.push({ name, passed: Boolean(condition) });
  console.log(`${condition ? "ok" : "not ok"} - ${name}${detail ? ` # ${detail}` : ""}`);
  assert.ok(condition, name);
}

async function checkNoPageOverflow(page, label) {
  const dimensions = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  check(`${label} at 360px does not scroll sideways`, dimensions.scrollWidth <= dimensions.clientWidth + 1,
    `${dimensions.scrollWidth}px scroll width; ${dimensions.clientWidth}px viewport width`);
}

async function saveSanitizedScreenshot(page, filename, maximumWidth, maximumHeight) {
  if (!screenshotDirectory) return;
  const path = resolve(screenshotDirectory, filename);
  assert.ok(path.startsWith(`${screenshotDirectory}${sep}`), "screenshot path must remain inside the supplied directory");
  await page.screenshot({ path, fullPage: false, animations: "disabled" });
  const image = await readFile(path);
  const isPng = image.length >= 24 && image.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"));
  const width = isPng ? image.readUInt32BE(16) : 0;
  const height = isPng ? image.readUInt32BE(20) : 0;
  check(`sanitized ${filename} was written as a bounded PNG`, isPng && image.length <= 5 * 1024 * 1024
    && width <= maximumWidth && height <= maximumHeight, `${width}x${height}; bytes=${image.length}`);
}

const disposable = await fixture();
const assets = await loadPrivateClientAssets(await realpath("dist-vps/client"));
let application;
let browser;
const posts = [];

async function installProtectedRequestRouting(context) {
  await context.route("**/*", async route => {
    const browserRequest = route.request();
    const url = new URL(browserRequest.url());
    if (url.origin !== origin) {
      await route.abort("blockedbyclient");
      return;
    }
    const headers = new Headers(browserRequest.headers());
    headers.set("cf-access-jwt-assertion", token());
    headers.set("accept", headers.get("accept") ?? "text/html");
    if (!["GET", "HEAD"].includes(browserRequest.method())) headers.set("origin", origin);
    const body = browserRequest.postDataBuffer();
    if (browserRequest.method() === "POST" && url.pathname.startsWith("/api/")) {
      posts.push(Object.freeze({ path: url.pathname, body: body?.toString("utf8") ?? "",
        idempotencyKey: headers.get("idempotency-key") }));
    }
    const staticResponse = (url.pathname.startsWith("/_next/") || url.pathname === "/favicon.svg") && !url.search
      ? assets.respond(url.pathname, browserRequest.method()) : undefined;
    const response = staticResponse ?? await handler(new Request(browserRequest.url(), { method: browserRequest.method(), headers,
      ...(!["GET", "HEAD"].includes(browserRequest.method()) && body ? { body } : {}) }));
    if (browserRequest.method() === "POST" && url.pathname.startsWith("/api/")) {
      console.log(`# browser command ${url.pathname} -> ${response.status}`);
    }
    const responseBody = browserRequest.method() === "HEAD" ? Buffer.alloc(0) : Buffer.from(await response.arrayBuffer());
    await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: responseBody });
  });
}

try {
  application = installPrivateWebProcess({ origin, ...trust,
    tenantId: "tenant:web", workspaceId: "workspace:web",
    database: { client: disposable.client, close: () => disposable.db.close() },
    clock: () => now, loadKeys: async () => trust.keys });

  browser = await playwright.chromium.launch({ headless: true });
  let context = await browser.newContext({ viewport: { width: 360, height: 844 } });
  await installProtectedRequestRouting(context);

  let page = await context.newPage();
  await page.goto(`${origin}/`, { waitUntil: "domcontentloaded" });
  const homeHeadings = await page.getByRole("heading", { level: 1 }).allTextContents();
  check("compiled private home rendered", homeHeadings.length === 1 && /Control Room/.test(homeHeadings[0]),
    `heading=${JSON.stringify(homeHeadings)}`);
  await checkNoPageOverflow(page, "home");
  await page.locator("body").focus();
  await page.keyboard.press("Tab");
  check("skip link is first keyboard target", await page.locator(":focus").evaluate(element =>
    element.matches("a.skip-link") && element.textContent?.trim() === "Skip to content"));

  await page.goto(`${origin}/projects`, { waitUntil: "domcontentloaded" });
  await page.locator("#project-title").waitFor({ state: "visible" });
  await page.locator("#project-title").fill("Browser acceptance alpha");
  await page.locator("#project-summary").fill("Disposable project proving the compiled private application journey.");
  await page.getByRole("button", { name: "Create project" }).click();
  await page.waitForTimeout(1000);
  const alphaVisible = await page.getByRole("heading", { name: "Browser acceptance alpha" }).isVisible().catch(() => false);
  check("created project opened after its confirmed save", alphaVisible,
    `url=${new URL(page.url()).pathname}; alerts=${JSON.stringify(await page.getByRole("alert").allTextContents())}`);
  const alphaPath = new URL(page.url()).pathname;
  check("project creation navigated to its protected page", /^\/projects\/project%3A/.test(alphaPath), alphaPath);
  await checkNoPageOverflow(page, "project overview");

  await page.getByRole("link", { name: "Work", exact: true }).click();
  await page.locator("#task-title").waitFor({ state: "visible" });
  await page.locator("#task-title").fill("Acceptance task");
  await page.locator("#task-instructions").fill("Return a short verified result. Do not perform external actions.");
  await page.getByRole("button", { name: "Save proposal" }).click();
  await page.getByRole("heading", { name: "Acceptance task" }).waitFor();
  check("task proposal opened its protected detail", /\/tasks\/job%3A/.test(new URL(page.url()).pathname));
  await checkNoPageOverflow(page, "task detail");
  const alphaTaskPath = new URL(page.url()).pathname;
  check("saved task route remains scoped to its alpha project", alphaTaskPath.startsWith(`${alphaPath}/tasks/`), alphaTaskPath);

  await page.goto(`${origin}/projects`, { waitUntil: "domcontentloaded" });
  await page.locator("#project-title").fill("Browser acceptance beta");
  await page.locator("#project-summary").fill("Second disposable project for isolation checks.");
  await page.getByRole("button", { name: "Create project" }).click();
  await page.getByRole("heading", { name: "Browser acceptance beta" }).waitFor();
  const betaPath = new URL(page.url()).pathname;
  await page.getByRole("link", { name: "Work", exact: true }).click();
  await page.locator("#task-title").waitFor({ state: "visible" });
  await page.locator("#task-title").fill("Beta acceptance task");
  await page.locator("#task-instructions").fill("Keep this disposable task isolated from Alpha.");
  await page.getByRole("button", { name: "Save proposal" }).click();
  await page.getByRole("heading", { name: "Beta acceptance task" }).waitFor();
  const betaTaskPath = new URL(page.url()).pathname;
  check("saved beta task route remains scoped to its beta project", betaTaskPath.startsWith(`${betaPath}/tasks/`), betaTaskPath);
  await page.goto(`${origin}${alphaPath}`, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Browser acceptance alpha" }).waitFor();

  const postCountBeforeReconnect = posts.length;
  await page.close();
  await context.close();
  context = await browser.newContext({ viewport: { width: 360, height: 844 } });
  await installProtectedRequestRouting(context);
  const reconnectedPage = await context.newPage();
  await reconnectedPage.goto(`${origin}${alphaPath}`, { waitUntil: "domcontentloaded" });
  await reconnectedPage.getByRole("heading", { name: "Browser acceptance alpha" }).waitFor();
  check("saved alpha project survives closing and reconnecting a browser context",
    await reconnectedPage.getByRole("heading", { name: "Browser acceptance alpha" }).isVisible());
  check("reconnected project route remains exactly scoped to alpha", new URL(reconnectedPage.url()).pathname === alphaPath,
    new URL(reconnectedPage.url()).pathname);
  const alphaTaskLinks = reconnectedPage.locator(`a[href="${alphaTaskPath}"]`);
  check("reconnected alpha project retains its saved task", await alphaTaskLinks.count() >= 1,
    `links=${await alphaTaskLinks.count()}`);
  check("reconnected alpha project does not show beta project data",
    await reconnectedPage.getByText("Browser acceptance beta", { exact: true }).count() === 0);
  check("reconnected alpha project does not show beta task data",
    await reconnectedPage.getByText("Beta acceptance task", { exact: true }).count() === 0);
  await reconnectedPage.goto(`${origin}${alphaTaskPath}`, { waitUntil: "domcontentloaded" });
  await reconnectedPage.getByRole("heading", { name: "Acceptance task" }).waitFor();
  check("saved alpha task survives closing and reconnecting a browser context",
    await reconnectedPage.getByRole("heading", { name: "Acceptance task" }).isVisible());
  const reconnectPosts = posts.slice(postCountBeforeReconnect);
  check("closing and reconnecting a browser context emits no protected command", reconnectPosts.length === 0,
    JSON.stringify(reconnectPosts));
  page = reconnectedPage;

  for (const [label, heading] of [["Files", "Project files"], ["Reviews", "Project reviews"],
    ["Activity", "Project activity"], ["Settings", "Project status"]]) {
    await page.getByRole("navigation", { name: "Project pages" }).getByRole("link", { name: label, exact: true }).click();
    await page.getByRole("heading", { name: heading }).waitFor();
    check(`${label.toLowerCase()} page is reachable from shared project navigation`, true);
    await checkNoPageOverflow(page, `${label.toLowerCase()} page`);
  }

  await page.getByRole("button", { name: "Archive project" }).click();
  await page.locator(".private-state").filter({ hasText: "archived" }).waitFor();
  check("archive is saved without removing project history", await page.getByText("Browser acceptance alpha", { exact: true }).isVisible());
  await page.getByRole("button", { name: "Reopen project" }).click();
  await page.locator(".private-state").filter({ hasText: "active" }).waitFor();
  check("archived project can be reopened", true);
  await page.setViewportSize({ width: 1280, height: 900 });
  await saveSanitizedScreenshot(page, "private-browser-wide.png", 1280, 900);
  await page.setViewportSize({ width: 360, height: 844 });

  await page.goto(`${origin}${betaPath}`, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Browser acceptance beta" }).waitFor();
  await page.getByRole("link", { name: "Work", exact: true }).click();
  await page.getByRole("heading", { name: "Browser acceptance beta" }).waitFor();
  check("second project does not show first project task", await page.getByText("Acceptance task", { exact: true }).count() === 0);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Browser acceptance beta" }).waitFor();
  check("saved second project survives browser reload", await page.getByRole("heading", { name: "Browser acceptance beta" }).isVisible());
  await checkNoPageOverflow(page, "reloaded second project");

  await page.goto(`${origin}/`, { waitUntil: "domcontentloaded" });
  const menu = page.getByRole("button", { name: "Menu" });
  await menu.click();
  check("narrow-screen menu exposes workspace navigation", await menu.getAttribute("aria-expanded") === "true"
    && await page.getByRole("navigation", { name: "Workspace pages" }).getByRole("link", { name: "Projects" }).isVisible());
  await checkNoPageOverflow(page, "open workspace menu");
  await page.getByRole("navigation", { name: "Workspace pages" }).getByRole("link", { name: "Projects" }).click();
  await page.waitForURL(url => url.pathname === "/projects");
  check("360px workspace menu link remains operable", true);
  await checkNoPageOverflow(page, "project catalog reached through the workspace menu");
  await saveSanitizedScreenshot(page, "private-browser-narrow.png", 360, 844);

  const createPosts = posts.filter(entry => entry.path === "/api/v1/projects");
  const taskPosts = posts.filter(entry => /\/tasks$/.test(entry.path));
  check("each project save crossed the command boundary once", createPosts.length === 2);
  check("each task save crossed the command boundary once", taskPosts.length === 2);
  check("all saved commands carried an idempotency key", [...createPosts, ...taskPosts]
    .every(entry => typeof entry.idempotencyKey === "string" && entry.idempotencyKey.length >= 8));

  await context.close();
  console.log(`# ${checks.filter(value => value.passed).length}/${checks.length} checks passed; no listener or remote request was created`);
} finally {
  if (browser) await browser.close().catch(() => {});
  if (application) await application.close().catch(() => {});
  else await disposable.db.close().catch(() => {});
}
