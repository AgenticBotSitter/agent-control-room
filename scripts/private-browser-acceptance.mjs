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
import { realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";

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

const disposable = await fixture();
const assets = await loadPrivateClientAssets(await realpath("dist-vps/client"));
let application;
let browser;
const posts = [];

try {
  application = installPrivateWebProcess({ origin, ...trust,
    tenantId: "tenant:web", workspaceId: "workspace:web",
    database: { client: disposable.client, close: () => disposable.db.close() },
    clock: () => now, loadKeys: async () => trust.keys });

  browser = await playwright.chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
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

  const page = await context.newPage();
  await page.goto(`${origin}/`, { waitUntil: "domcontentloaded" });
  const homeHeadings = await page.getByRole("heading", { level: 1 }).allTextContents();
  check("compiled private home rendered", homeHeadings.length === 1 && /Control Room/.test(homeHeadings[0]),
    `heading=${JSON.stringify(homeHeadings)}`);
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

  await page.getByRole("link", { name: "Work", exact: true }).click();
  await page.locator("#task-title").waitFor({ state: "visible" });
  await page.locator("#task-title").fill("Acceptance task");
  await page.locator("#task-instructions").fill("Return a short verified result. Do not perform external actions.");
  await page.getByRole("button", { name: "Save proposal" }).click();
  await page.getByRole("heading", { name: "Acceptance task" }).waitFor();
  check("task proposal opened its protected detail", /\/tasks\/job%3A/.test(new URL(page.url()).pathname));

  for (const [label, heading] of [["Files", "Project files"], ["Reviews", "Project reviews"],
    ["Activity", "Project activity"], ["Settings", "Project status"]]) {
    await page.getByRole("navigation", { name: "Project pages" }).getByRole("link", { name: label, exact: true }).click();
    await page.getByRole("heading", { name: heading }).waitFor();
    check(`${label.toLowerCase()} page is reachable from shared project navigation`, true);
  }

  await page.getByRole("button", { name: "Archive project" }).click();
  await page.locator(".private-state").filter({ hasText: "archived" }).waitFor();
  check("archive is saved without removing project history", await page.getByText("Browser acceptance alpha", { exact: true }).isVisible());
  await page.getByRole("button", { name: "Reopen project" }).click();
  await page.locator(".private-state").filter({ hasText: "active" }).waitFor();
  check("archived project can be reopened", true);

  await page.goto(`${origin}/projects`, { waitUntil: "domcontentloaded" });
  await page.locator("#project-title").fill("Browser acceptance beta");
  await page.locator("#project-summary").fill("Second disposable project for isolation checks.");
  await page.getByRole("button", { name: "Create project" }).click();
  await page.getByRole("heading", { name: "Browser acceptance beta" }).waitFor();
  await page.getByRole("link", { name: "Work", exact: true }).click();
  await page.getByRole("heading", { name: "Browser acceptance beta" }).waitFor();
  check("second project does not show first project task", await page.getByText("Acceptance task", { exact: true }).count() === 0);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Browser acceptance beta" }).waitFor();
  check("saved second project survives browser reload", await page.getByRole("heading", { name: "Browser acceptance beta" }).isVisible());

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${origin}/`, { waitUntil: "domcontentloaded" });
  const menu = page.getByRole("button", { name: "Menu" });
  await menu.click();
  check("narrow-screen menu exposes workspace navigation", await menu.getAttribute("aria-expanded") === "true"
    && await page.getByRole("navigation", { name: "Workspace pages" }).getByRole("link", { name: "Projects" }).isVisible());

  const createPosts = posts.filter(entry => entry.path === "/api/v1/projects");
  const taskPosts = posts.filter(entry => /\/tasks$/.test(entry.path));
  check("each project save crossed the command boundary once", createPosts.length === 2);
  check("task save crossed the command boundary once", taskPosts.length === 1);
  check("all saved commands carried an idempotency key", [...createPosts, ...taskPosts]
    .every(entry => typeof entry.idempotencyKey === "string" && entry.idempotencyKey.length >= 8));

  await context.close();
  console.log(`# ${checks.filter(value => value.passed).length}/${checks.length} checks passed; no listener or remote request was created`);
} finally {
  if (browser) await browser.close().catch(() => {});
  if (application) await application.close().catch(() => {});
  else await disposable.db.close().catch(() => {});
}
