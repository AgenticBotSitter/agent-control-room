#!/usr/bin/env node
// Real-browser acceptance for uncertain project saves in the compiled private app.
// A lost request and a lost reply are injected separately. All data and identities
// are disposable; no listener, remote request, credential or native agent is used.

import assert from "node:assert/strict";
import { realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const requireFromRepo = createRequire(resolve("package.json"));
let playwright;
for (const candidate of [process.env.PLAYWRIGHT_MODULE, "playwright"]) {
  if (!candidate) continue;
  try { playwright = requireFromRepo(candidate); break; } catch { /* use only an available installation */ }
}
if (!playwright) {
  console.error("private-uncertain-save-browser-acceptance: Playwright not found. Set PLAYWRIGHT_MODULE to an existing Playwright installation.");
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
let dropMode;
const posts = [];

try {
  application = installPrivateWebProcess({ origin, ...trust,
    tenantId: "tenant:web", workspaceId: "workspace:web",
    database: { client: disposable.client, close: () => disposable.db.close() },
    clock: () => now, loadKeys: async () => trust.keys });

  browser = await playwright.chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.route("**/*", async route => {
    const browserRequest = route.request(), url = new URL(browserRequest.url());
    if (url.origin !== origin) { await route.abort("blockedbyclient"); return; }
    const headers = new Headers(browserRequest.headers());
    headers.set("cf-access-jwt-assertion", token());
    headers.set("accept", headers.get("accept") ?? "text/html");
    if (!["GET", "HEAD"].includes(browserRequest.method())) headers.set("origin", origin);
    const body = browserRequest.postDataBuffer();
    const projectCreate = browserRequest.method() === "POST" && url.pathname === "/api/v1/projects";
    const entry = projectCreate ? { path: url.pathname, body: body?.toString("utf8") ?? "",
      idempotencyKey: headers.get("idempotency-key") ?? "", delivered: false } : undefined;
    if (entry) posts.push(entry);
    const mode = projectCreate ? dropMode : undefined;
    if (mode) dropMode = undefined;
    if (mode === "request") { await route.abort("failed"); return; }

    const staticResponse = (url.pathname.startsWith("/_next/") || url.pathname === "/favicon.svg") && !url.search
      ? assets.respond(url.pathname, browserRequest.method()) : undefined;
    const response = staticResponse ?? await handler(new Request(browserRequest.url(), {
      method: browserRequest.method(), headers,
      ...(!["GET", "HEAD"].includes(browserRequest.method()) && body ? { body } : {}),
    }));
    if (entry) entry.delivered = true;
    if (mode === "response") { await response.arrayBuffer(); await route.abort("failed"); return; }
    const responseBody = browserRequest.method() === "HEAD" ? Buffer.alloc(0) : Buffer.from(await response.arrayBuffer());
    await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: responseBody });
  });

  const countProjects = async () => Number((await disposable.client.query("SELECT count(*) AS count FROM projects")).rows[0].count);
  const page = await context.newPage();
  await page.goto(`${origin}/projects`, { waitUntil: "domcontentloaded" });
  await page.locator("#project-title").waitFor({ state: "visible" });

  const requestTitle = "Lost request project";
  await page.locator("#project-title").fill(requestTitle);
  await page.locator("#project-summary").fill("The first request never reaches Control Room.");
  dropMode = "request";
  await page.getByRole("button", { name: "Create project" }).click();
  await page.getByRole("region", { name: "Unconfirmed project save" }).waitFor();
  check("lost request is shown as unconfirmed", await page.getByRole("button", { name: "Retry original save" }).isVisible());
  check("lost request created no project", await countProjects() === 0);

  await page.getByRole("button", { name: "Retry original save" }).click();
  await page.getByRole("heading", { name: requestTitle, exact: true }).waitFor();
  const requestPosts = posts.filter(entry => entry.body.includes(requestTitle));
  check("explicit retry replays the exact lost request", requestPosts.length === 2
    && requestPosts[0].body === requestPosts[1].body
    && requestPosts[0].idempotencyKey.length >= 8
    && requestPosts[0].idempotencyKey === requestPosts[1].idempotencyKey);
  check("only the explicit retry reached the server", !requestPosts[0].delivered && requestPosts[1].delivered);
  check("lost-request recovery created exactly one project", await countProjects() === 1);

  const replyTitle = "Lost reply project";
  await page.goto(`${origin}/projects`, { waitUntil: "domcontentloaded" });
  await page.locator("#project-title").fill(replyTitle);
  await page.locator("#project-summary").fill("Control Room saves this project, but the browser loses the reply.");
  dropMode = "response";
  await page.getByRole("button", { name: "Create project" }).click();
  await page.getByRole("region", { name: "Unconfirmed project save" }).waitFor();
  const replyPostsBeforeRead = posts.filter(entry => entry.body.includes(replyTitle));
  check("lost reply is shown as unconfirmed after server acceptance",
    replyPostsBeforeRead.length === 1 && replyPostsBeforeRead[0].delivered && await countProjects() === 2);

  const observer = await context.newPage();
  await observer.goto(`${origin}/projects`, { waitUntil: "domcontentloaded" });
  await observer.getByText(replyTitle, { exact: true }).waitFor();
  check("read-only project check reveals the saved project without another POST",
    posts.filter(entry => entry.body.includes(replyTitle)).length === 1);
  await observer.close();

  await page.getByRole("button", { name: "Retry original save" }).click();
  await page.getByRole("heading", { name: replyTitle, exact: true }).waitFor();
  const replyPosts = posts.filter(entry => entry.body.includes(replyTitle));
  check("explicit lost-reply check reuses the exact body and request key", replyPosts.length === 2
    && replyPosts.every(entry => entry.delivered)
    && replyPosts[0].body === replyPosts[1].body
    && replyPosts[0].idempotencyKey.length >= 8
    && replyPosts[0].idempotencyKey === replyPosts[1].idempotencyKey);
  check("lost-reply reconciliation did not duplicate the project", await countProjects() === 2);

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: replyTitle, exact: true }).waitFor();
  check("reload does not repeat either recovered save", posts.length === 4);

  await context.close();
  console.log(`# ${checks.filter(value => value.passed).length}/${checks.length} checks passed; request loss and reply loss remained distinct`);
} finally {
  if (browser) await browser.close().catch(() => {});
  if (application) await application.close().catch(() => {});
  else await disposable.db.close().catch(() => {});
}
