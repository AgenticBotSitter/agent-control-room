#!/usr/bin/env node
// Automated accessibility acceptance for the compiled private Control Room.
//
// The browser is connected to the built Request handler through Playwright route
// interception. No listener, remote request, production credential or native agent
// is used. State is held in one disposable PGlite database.

import assert from "node:assert/strict";
import { realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";

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
  assert.ok(condition, `${name}${detail ? `: ${detail}` : ""}`);
}

async function audit(page, label) {
  await page.locator("main").waitFor({ state: "visible" });
  await page.getByRole("heading", { level: 1 }).waitFor();
  await page.waitForTimeout(100);
  const dom = await page.evaluate(() => {
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
    return { lang: document.documentElement.lang, title: document.title, duplicates, unnamedFields, unnamedControls,
      headings, headingJumps, mainCount: main.length, h1Count: headings.filter(heading => heading.level === 1).length,
      skipPresent: Boolean(skip), horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1 };
  });
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
}

const disposable = await fixture();
const assets = await loadPrivateClientAssets(await realpath("dist-vps/client"));
let application;
let browser;
try {
  application = installPrivateWebProcess({ origin, ...trust,
    tenantId: "tenant:web", workspaceId: "workspace:web",
    database: { client: disposable.client, close: () => disposable.db.close() },
    clock: () => now, loadKeys: async () => trust.keys });
  browser = await playwright.chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.route("**/*", async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin) { await route.abort("blockedbyclient"); return; }
    const headers = new Headers(request.headers());
    headers.set("cf-access-jwt-assertion", token());
    headers.set("accept", headers.get("accept") ?? "text/html");
    if (!["GET", "HEAD"].includes(request.method())) headers.set("origin", origin);
    const body = request.postDataBuffer();
    const staticResponse = (url.pathname.startsWith("/_next/") || url.pathname === "/favicon.svg") && !url.search
      ? assets.respond(url.pathname, request.method()) : undefined;
    const response = staticResponse ?? await handler(new Request(request.url(), { method: request.method(), headers,
      ...(!["GET", "HEAD"].includes(request.method()) && body ? { body } : {}) }));
    await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers),
      body: request.method() === "HEAD" ? Buffer.alloc(0) : Buffer.from(await response.arrayBuffer()) });
  });

  const page = await context.newPage();
  for (const [path, label] of [["/", "Home"], ["/projects", "Project catalog"], ["/workers", "Workers"],
    ["/needs-me", "Needs attention"], ["/settings", "Settings"], ["/ideas", "Idea Lab"]]) {
    await page.goto(`${origin}${path}`, { waitUntil: "domcontentloaded" });
    await audit(page, label);
  }

  await page.goto(`${origin}/projects`, { waitUntil: "domcontentloaded" });
  await page.locator("#project-title").fill("Accessibility acceptance project");
  await page.locator("#project-summary").fill("Disposable project used to audit protected project and task pages.");
  await page.getByRole("button", { name: "Create project" }).click();
  await page.getByRole("heading", { name: "Accessibility acceptance project" }).waitFor();
  const projectPath = new URL(page.url()).pathname;
  await audit(page, "Project overview");
  for (const [section, label] of [["tasks", "Project work"], ["files", "Project files"], ["reviews", "Project reviews"],
    ["activity", "Project activity"], ["settings", "Project settings"], ["news", "Project news"]]) {
    const response = await page.goto(`${origin}${projectPath}/${section}`, { waitUntil: "domcontentloaded" });
    check(`${label}: protected page route responds`, response?.status() === 200, `status=${response?.status() ?? "none"}`);
    await audit(page, label);
  }

  await page.goto(`${origin}${projectPath}/tasks`, { waitUntil: "domcontentloaded" });
  await page.locator("#task-title").fill("Accessible task detail");
  await page.locator("#task-instructions").fill("Return a short saved result without external actions.");
  await page.getByRole("button", { name: "Save proposal" }).click();
  await page.getByRole("heading", { name: "Accessible task detail" }).waitFor();
  await audit(page, "Task detail");

  await page.goto(`${origin}/`, { waitUntil: "domcontentloaded" });
  await page.locator("body").focus();
  await page.keyboard.press("Tab");
  const focused = page.locator(":focus");
  check("skip link is the first keyboard target", await focused.evaluate(element => element.matches("a.skip-link")));
  await page.keyboard.press("Enter");
  check("skip link moves focus to main content", await page.locator("main#private-main:focus").count() === 1);

  await context.close();
  console.log(`# ${checks.filter(value => value.passed).length}/${checks.length} accessibility checks passed across the compiled protected application`);
} finally {
  if (browser) await browser.close().catch(() => {});
  if (application) await application.close().catch(() => {});
  else await disposable.db.close().catch(() => {});
}
