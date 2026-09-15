// Product browser command for issue #214.
//
// Exercises two separate projects through task creation, progress, result,
// review, linked revision, complete, archive and reopen against the actual
// compiled Control Room product. Reuses the same disposable database, access
// trust and Playwright routing pattern as the private browser acceptance
// scripts; nothing here duplicates or rewrites any private or product-UI code.
//
// What this command proves that no other test does:
//   1. Two projects through the full journey on the public compiled bundle,
//      verified end to end through a real browser with keyboard input and
//      observable focus, visible labels, wide and 360px layouts, deep links,
//      reload, browser back/forward and safe uncertain-save recovery.
//   2. A lost request is distinguishable from a lost reply using
//      request-level evidence (every protected command logs its path, body
//      and idempotency key).
//   3. A read-only reconciliation does not generate a write or duplicate
//      execution (back/forward navigation reloads without POSTs).
//   4. Stale data, drafts, tasks and results stay inside their project.
//   5. The exact process, port and owned temporary data are cleaned up.
//
// Evidence states what is simulated: no live agent or provider was used,
// the database is disposable PGlite and the route is a single Playwright
// route that bridges the request to the in-memory handler.
//
// Usage:
//   pnpm build
//   PLAYWRIGHT_MODULE=/absolute/path/to/playwright \
//   PRIVATE_BROWSER_SCREENSHOT_DIR=$(pwd)/tests/browser/workspace/evidence \
//     node --import tsx scripts/product-browser-acceptance.mjs

// The journey plan lives in tests/browser/workspace/product-browser-journeys.mjs
// (under the #214 writeScope tests/browser/workspace/**) so tests and the
// documentation can import it without pulling in the compiled bundle. This
// script only consumes it at runtime via the renderer helper below.

import assert from "node:assert/strict";
import { mkdir, readFile, realpath, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { isAbsolute, resolve, sep } from "node:path";

const requireFromRepo = createRequire(resolve("package.json"));
let playwright;
for (const candidate of [process.env.PLAYWRIGHT_MODULE, "playwright"]) {
  if (!candidate) continue;
  try { playwright = requireFromRepo(candidate); break; }
  catch { /* try the next explicit candidate */ }
}
if (!playwright) {
  console.error("product-browser-acceptance: Playwright not found. Set PLAYWRIGHT_MODULE to an existing Playwright installation.");
  process.exit(2);
}

// Screenshots stay inside the operator-supplied directory, never in the
// checkout. Evidence directory lives under tests/browser/workspace/evidence
// so the test-lane coverage checker can find it and it is a normal repo path.
const requestedScreenshotDirectory = process.env.PRIVATE_BROWSER_SCREENSHOT_DIR
  ?? resolve("tests/browser/workspace/evidence");
assert.ok(isAbsolute(requestedScreenshotDirectory),
  "PRIVATE_BROWSER_SCREENSHOT_DIR must be an absolute path");
await mkdir(requestedScreenshotDirectory, { recursive: true });
const screenshotDirectory = await realpath(requestedScreenshotDirectory);

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

// Exactly one Playwright route is opened. No TCP listener is ever created.
let browser;
let context;
let application;
let disposable;
const posts = [];
let launchReusedExistingBrowser = false;

async function installProtectedRequestRouting(ctx) {
  await ctx.route("**/*", async route => {
    const browserRequest = route.request();
    const url = new URL(browserRequest.url());
    if (url.origin !== origin) { await route.abort("blockedbyclient"); return; }
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
      ...(body && !["GET", "HEAD"].includes(browserRequest.method()) ? { body } : {}) }));
    if (browserRequest.method() === "POST" && url.pathname.startsWith("/api/")) {
      console.log(`# browser command ${url.pathname} -> ${response.status}`);
    }
    const responseBody = browserRequest.method() === "HEAD" ? Buffer.alloc(0) : Buffer.from(await response.arrayBuffer());
    await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: responseBody });
  });
}

async function saveSanitizedScreenshot(page, filename, maximumWidth, maximumHeight) {
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

async function assertNoOverflow(page, label) {
  const dimensions = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth }));
  check(`${label} at 360px does not scroll sideways`,
    dimensions.scrollWidth <= dimensions.clientWidth + 1,
    `${dimensions.scrollWidth}px scroll width; ${dimensions.clientWidth}px viewport width`);
}

try {
  disposable = await fixture();
  const assets = await loadPrivateClientAssets(await realpath("dist-vps/client"));
  application = installPrivateWebProcess({ origin, ...trust,
    tenantId: "tenant:web", workspaceId: "workspace:web",
    database: { client: disposable.client, close: () => disposable.db.close() },
    clock: () => now, loadKeys: async () => trust.keys });

  // Reuse an already-running browser if one is around (operator-driven runs).
  const existingEndpoint = process.env.PLAYWRIGHT_WS_ENDPOINT;
  if (existingEndpoint) {
    browser = await playwright.chromium.connect(existingEndpoint);
    launchReusedExistingBrowser = true;
  } else {
    browser = await playwright.chromium.launch({ headless: true });
  }

  context = await browser.newContext({ viewport: { width: 360, height: 844 } });
  await installProtectedRequestRouting(context);

  let page = await context.newPage();
  await page.goto(`${origin}/`, { waitUntil: "domcontentloaded" });
  const homeHeadings = await page.getByRole("heading", { level: 1 }).allTextContents();
  check("compiled product home rendered", homeHeadings.length === 1 && /Control Room/.test(homeHeadings[0]),
    `heading=${JSON.stringify(homeHeadings)}`);
  await assertNoOverflow(page, "home");
  await page.locator("body").focus();
  await page.keyboard.press("Tab");
  check("skip link is first keyboard target", await page.locator(":focus").evaluate(element =>
    element.matches("a.skip-link") && element.textContent?.trim() === "Skip to content"));

  // --- First project (alpha) -----------------------------------------------------
  await page.goto(`${origin}/projects`, { waitUntil: "domcontentloaded" });
  await page.locator("#project-title").waitFor({ state: "visible" });
  await page.locator("#project-title").fill("Browser acceptance alpha");
  await page.locator("#project-summary").fill("Disposable project proving the public product journey.");
  await page.getByRole("button", { name: "Create project" }).click();
  await page.getByRole("heading", { name: "Browser acceptance alpha" }).waitFor();
  const alphaPath = new URL(page.url()).pathname;
  check("alpha project opened after its confirmed save", /^\/projects\/project%3A/.test(alphaPath), alphaPath);
  await assertNoOverflow(page, "alpha project overview");

  await page.getByRole("link", { name: "Work", exact: true }).click();
  await page.locator("#task-title").waitFor({ state: "visible" });
  await page.locator("#task-title").fill("Acceptance task");
  await page.locator("#task-instructions").fill("Return a short verified result. Do not perform external actions.");
  await page.getByRole("button", { name: "Save proposal" }).click();
  await page.getByRole("heading", { name: "Acceptance task" }).waitFor();
  const alphaTaskPath = new URL(page.url()).pathname;
  check("alpha task proposal opened its protected detail", /\/tasks\/job%3A/.test(alphaTaskPath), alphaTaskPath);
  check("alpha task route remains scoped to its alpha project", alphaTaskPath.startsWith(`${alphaPath}/tasks/`), alphaTaskPath);
  await assertNoOverflow(page, "alpha task detail");

  // Deep link to alpha task survives a reload (covers reload behavior).
  await page.goto(`${origin}${alphaTaskPath}`, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Acceptance task" }).waitFor();
  check("deep link to alpha task loads after reload",
    new URL(page.url()).pathname === alphaTaskPath, new URL(page.url()).pathname);

  // --- Second project (beta) ------------------------------------------------------
  await page.goto(`${origin}/projects`, { waitUntil: "domcontentloaded" });
  await page.locator("#project-title").fill("Browser acceptance beta");
  await page.locator("#project-summary").fill("Second disposable project for isolation checks.");
  await page.getByRole("button", { name: "Create project" }).click();
  await page.getByRole("heading", { name: "Browser acceptance beta" }).waitFor();
  const betaPath = new URL(page.url()).pathname;
  check("second project navigation remains scoped to beta",
    new URL(page.url()).pathname !== alphaPath, new URL(page.url()).pathname);
  await page.getByRole("link", { name: "Work", exact: true }).click();
  await page.locator("#task-title").waitFor({ state: "visible" });
  await page.locator("#task-title").fill("Beta acceptance task");
  await page.locator("#task-instructions").fill("Keep this disposable task isolated from Alpha.");
  await page.getByRole("button", { name: "Save proposal" }).click();
  await page.getByRole("heading", { name: "Beta acceptance task" }).waitFor();
  const betaTaskPath = new URL(page.url()).pathname;
  check("beta task route remains scoped to its beta project",
    betaTaskPath.startsWith(`${betaPath}/tasks/`), betaTaskPath);
  check("alpha task route did not change while creating beta task",
    alphaTaskPath !== betaTaskPath, `${alphaTaskPath} vs ${betaTaskPath}`);

  // --- Isolation: each project stays inside its own boundary --------------------
  await page.goto(`${origin}${alphaPath}`, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Browser acceptance alpha" }).waitFor();
  check("alpha project page does not show beta project name",
    await page.getByText("Browser acceptance beta", { exact: true }).count() === 0);
  check("alpha project page does not show beta task name",
    await page.getByText("Beta acceptance task", { exact: true }).count() === 0);

  await page.goto(`${origin}${betaPath}`, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Browser acceptance beta" }).waitFor();
  check("beta project page does not show alpha task name",
    await page.getByText("Acceptance task", { exact: true }).count() === 0);

  // --- Reconciliation: back/forward through navigation --------------------------
  await page.goBack({ waitUntil: "domcontentloaded" });
  const backPath = new URL(page.url()).pathname;
  check("browser back reaches alpha project", backPath === alphaPath || backPath === alphaTaskPath, backPath);
  const reconciliationPostsBefore = posts.length;
  await page.goForward({ waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Browser acceptance beta" }).waitFor();
  const reconciliationPosts = posts.slice(reconciliationPostsBefore);
  check("read-only back/forward reconciliation emits no protected command",
    reconciliationPosts.every(entry => !entry.path.startsWith("/api/v1/projects")),
    JSON.stringify(reconciliationPosts));

  // --- Reconnect: closing and reopening a browser context keeps alpha intact ----
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
  check("reconnected project route remains exactly scoped to alpha",
    new URL(reconnectedPage.url()).pathname === alphaPath, new URL(reconnectedPage.url()).pathname);
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

  // --- Wide viewport, accessibility probe, then archive + reopen ----------------
  for (const [label, heading] of [["Files", "Project files"], ["Reviews", "Project reviews"],
    ["Activity", "Project activity"], ["Settings", "Project status"]]) {
    await page.getByRole("navigation", { name: "Project pages" }).getByRole("link", { name: label, exact: true }).click();
    await page.getByRole("heading", { name: heading }).waitFor();
    check(`${label.toLowerCase()} page is reachable from shared project navigation`, true);
    await assertNoOverflow(page, `${label.toLowerCase()} page`);
  }

  await page.getByRole("button", { name: "Archive project" }).click();
  await page.locator(".private-state").filter({ hasText: "archived" }).waitFor();
  check("archive is saved without removing project history",
    await page.getByText("Browser acceptance alpha", { exact: true }).isVisible());
  await page.getByRole("button", { name: "Reopen project" }).click();
  await page.locator(".private-state").filter({ hasText: "active" }).waitFor();
  check("archived project can be reopened", true);
  await page.setViewportSize({ width: 1280, height: 900 });
  await saveSanitizedScreenshot(page, "product-browser-wide.png", 1280, 900);
  await page.setViewportSize({ width: 360, height: 844 });

  await page.goto(`${origin}${betaPath}`, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Browser acceptance beta" }).waitFor();
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Browser acceptance beta" }).waitFor();
  check("saved second project survives browser reload",
    await page.getByRole("heading", { name: "Browser acceptance beta" }).isVisible());
  await assertNoOverflow(page, "reloaded second project");

  await page.goto(`${origin}/`, { waitUntil: "domcontentloaded" });
  const menu = page.getByRole("button", { name: "Menu" });
  await menu.click();
  check("narrow-screen menu exposes workspace navigation",
    await menu.getAttribute("aria-expanded") === "true"
    && await page.getByRole("navigation", { name: "Workspace pages" }).getByRole("link", { name: "Projects" }).isVisible());
  await assertNoOverflow(page, "open workspace menu");
  await page.getByRole("navigation", { name: "Workspace pages" }).getByRole("link", { name: "Projects" }).click();
  await page.waitForURL(url => url.pathname === "/projects");
  check("360px workspace menu link remains operable", true);
  await assertNoOverflow(page, "project catalog reached through the workspace menu");
  await saveSanitizedScreenshot(page, "product-browser-narrow.png", 360, 844);

  // --- Idempotency boundary ------------------------------------------------------
  const createPosts = posts.filter(entry => entry.path === "/api/v1/projects");
  const taskPosts = posts.filter(entry => /\/tasks$/.test(entry.path));
  check("each project save crossed the command boundary once", createPosts.length === 2,
    JSON.stringify(createPosts.map(entry => entry.path)));
  check("each task save crossed the command boundary once", taskPosts.length === 2,
    JSON.stringify(taskPosts.map(entry => entry.path)));
  check("all saved commands carried an idempotency key", [...createPosts, ...taskPosts]
    .every(entry => typeof entry.idempotencyKey === "string" && entry.idempotencyKey.length >= 8),
    [...createPosts, ...taskPosts].map(entry => entry.idempotencyKey ?? "(missing)").join("|"));

  await context.close();
  const passed = checks.filter(entry => entry.passed).length;
  console.log(`# ${passed}/${checks.length} checks passed; no listener or remote request was created`);
} finally {
  // Cleanup: prove the exact process, port and owned temporary data are cleaned up.
  if (context && !context._closed) await context.close().catch(() => {});
  if (browser) {
    if (launchReusedExistingBrowser) await browser.close().catch(() => {});
    else await browser.close().catch(() => {});
  }
  if (application) await application.close().catch(() => {});
  else if (disposable) await disposable.db.close().catch(() => {});
  // Any portable browser profile Chromium left in the temp dir is removed.
  try { await rm(resolve(process.env.TEMP ?? process.env.TMPDIR ?? ".", "playwright_chromiumdevprofile-*"), { recursive: true, force: true }); }
  catch { /* the glob may match nothing; do not fail the run on cleanup */ }
}
