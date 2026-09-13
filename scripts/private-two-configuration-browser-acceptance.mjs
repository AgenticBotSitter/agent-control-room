#!/usr/bin/env node
// Proves one compiled Control Room artifact can serve two isolated custom products.
// Each profile runs in its own child process because production deliberately permits
// only one installed private application per process. No listener or remote request
// is created; each child owns a disposable PGlite database and generated test identity.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PRODUCT_CONFIGURATION_SCHEMA_V1 } from "../src/config/v1/product-configuration.ts";

const profiles = Object.freeze({
  research: Object.freeze({ displayName: "Research Room", timezone: "America/Denver",
    modules: Object.freeze({ ideaLab: true, news: true, sessionObservations: true }),
    template: "Research projects", project: "Research-only browser project" }),
  operations: Object.freeze({ displayName: "Operations Room", timezone: "UTC",
    modules: Object.freeze({ ideaLab: false, news: false, sessionObservations: false }),
    template: "Operations projects", project: "Operations-only browser project" }),
});
const layouts = Object.freeze({ wide: Object.freeze({ width: 1280, height: 900 }),
  narrow: Object.freeze({ width: 360, height: 844 }) });

const requestedProfile = process.argv.find(value => value.startsWith("--profile="))?.slice("--profile=".length);
if (!requestedProfile) {
  const results = [];
  for (const profile of Object.keys(profiles)) {
    const result = await new Promise((resolveResult, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(import.meta.url), `--profile=${profile}`],
        { cwd: process.cwd(), env: process.env, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "", stderr = "";
      child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
      child.stdout.on("data", chunk => { stdout += chunk; });
      child.stderr.on("data", chunk => { stderr += chunk; });
      child.once("error", reject);
      child.once("exit", code => {
        if (code !== 0) reject(new Error(`configuration child ${profile} failed (${code}): ${stderr.slice(-2000)}`));
        else {
          try { resolveResult(JSON.parse(stdout)); }
          catch { reject(new Error(`configuration child ${profile} returned invalid evidence: ${stdout.slice(-1000)}`)); }
        }
      });
    });
    results.push(result);
  }
  const [research, operations] = results;
  assert.equal(research.profile, "research");
  assert.equal(operations.profile, "operations");
  assert.equal(research.displayName, profiles.research.displayName);
  assert.equal(operations.displayName, profiles.operations.displayName);
  assert.deepEqual(research.modules, profiles.research.modules);
  assert.deepEqual(operations.modules, profiles.operations.modules);
  assert.deepEqual(Object.keys(research.layouts), Object.keys(layouts));
  assert.deepEqual(Object.keys(operations.layouts), Object.keys(layouts));
  assert.deepEqual(research.optionalRouteStatuses, { ideaLab: 200, news: 200, sessionObservations: 200 });
  assert.deepEqual(operations.optionalRouteStatuses, { ideaLab: 404, news: 404, sessionObservations: 404 });
  assert.deepEqual(research.projects, [profiles.research.project]);
  assert.deepEqual(operations.projects, [profiles.operations.project]);
  assert.ok(!research.settingsText.includes(profiles.operations.displayName));
  assert.ok(!operations.settingsText.includes(profiles.research.displayName));
  assert.ok(!research.projects.includes(profiles.operations.project));
  assert.ok(!operations.projects.includes(profiles.research.project));
  console.log("ok - one compiled artifact rendered two distinct product names and all optional-module selections");
  console.log("ok - each separately configured process retained only its own disposable project data");
  console.log("ok - wide and 360px settings and navigation exposed only truthful labels and direct links");
  console.log("ok - disabled optional UI and its protected routes remained unavailable");
  console.log("# 4/4 two-configuration browser checks passed; no listener, remote request or native agent was created");
  process.exit(0);
}

if (!(requestedProfile in profiles)) throw new Error("unknown_test_profile");
const profile = profiles[requestedProfile];
const requireFromRepo = createRequire(resolve("package.json"));
let playwright;
for (const candidate of [process.env.PLAYWRIGHT_MODULE, "playwright"]) {
  if (!candidate) continue;
  try { playwright = requireFromRepo(candidate); break; } catch { /* try next explicit candidate */ }
}
if (!playwright) throw new Error("Playwright not found; set PLAYWRIGHT_MODULE to an existing installation");

const { default: handler } = await import("../dist-vps/server/index.js");
const { installPrivateWebProcess } = await import("../dist-vps/server/runtime.js");
const { loadPrivateClientAssets } = await import("../dist-vps/server/serving.js");
const { fixture, now, origin, token, trust } = await import("../tests/helpers/web-foundation.ts");
const disposable = await fixture();
const assets = await loadPrivateClientAssets(await realpath("dist-vps/client"));
const productConfiguration = {
  schema: PRODUCT_CONFIGURATION_SCHEMA_V1,
  displayName: profile.displayName,
  defaultTimezone: profile.timezone,
  modules: profile.modules,
  limits: { maxProjects: 12, maxTasksPerProject: 100, maxResultsPerTask: 20,
    maxArticleSources: profile.modules.news ? 10 : 0, maxIdeaParticipants: profile.modules.ideaLab ? 6 : 0 },
  projectTemplates: [{ id: requestedProfile, displayName: profile.template,
    enabledModules: Object.entries(profile.modules).filter(([, enabled]) => enabled).map(([name]) => name) }],
};
let application;
let browser;
try {
  application = installPrivateWebProcess({ origin, ...trust, tenantId: "tenant:web", workspaceId: "workspace:web",
    database: { client: disposable.client, close: () => disposable.db.close() }, clock: () => now,
    loadKeys: async () => trust.keys, productConfiguration });
  browser = await playwright.chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: layouts.wide });
  await context.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url());
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
  await page.goto(`${origin}/`, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { level: 1, name: profile.displayName }).waitFor();
  const displayName = (await page.getByRole("heading", { level: 1 }).textContent())?.trim();

  await page.goto(`${origin}/projects`, { waitUntil: "domcontentloaded" });
  await page.locator("#project-title").fill(profile.project);
  await page.locator("#project-summary").fill(`Disposable data for the ${profile.displayName} configuration.`);
  await page.getByRole("button", { name: "Create project" }).click();
  await page.getByRole("heading", { level: 1, name: profile.project }).waitFor();
  const projectPath = new URL(page.url()).pathname;
  await page.goto(`${origin}/projects`, { waitUntil: "domcontentloaded" });
  await page.getByText(profile.project, { exact: true }).first().waitFor();
  const projects = (await page.locator(".private-project-grid h3").allTextContents()).map(value => value.trim());

  const optionalRouteStatuses = {};
  for (const [module, path] of [["ideaLab", "/ideas"], ["news", `${projectPath}/news`],
    ["sessionObservations", `/api/v1${projectPath}/observations`]]) {
    const response = await page.goto(`${origin}${path}`, { waitUntil: "domcontentloaded" });
    optionalRouteStatuses[module] = response?.status();
    assert.equal(response?.status(), profile.modules[module] ? 200 : 404);
    if (module === "ideaLab" && profile.modules[module]) await page.getByRole("heading", { level: 1, name: "Idea Lab" }).waitFor();
    if (module === "news" && profile.modules[module]) {
      await page.getByRole("heading", { level: 1, name: `${profile.project} · News` }).waitFor();
      await page.getByText("News storage is not configured for this installation. No sample stories are shown.", { exact: true }).waitFor();
    }
  }

  const layoutEvidence = {};
  let settingsText = "";
  for (const [layoutName, viewport] of Object.entries(layouts)) {
    await page.setViewportSize(viewport);
    await page.goto(`${origin}/`, { waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { level: 1, name: profile.displayName }).waitFor();
    const menu = page.getByRole("button", { name: "Menu" });
    assert.equal(await menu.isVisible(), layoutName === "narrow");
    if (layoutName === "narrow") {
      await menu.click();
      assert.equal(await menu.getAttribute("aria-expanded"), "true");
    }
    const workspaceNavigation = page.getByRole("navigation", { name: "Workspace pages" });
    const workspaceLinks = await workspaceNavigation.locator("a").evaluateAll(links => links.map(link => ({
      label: link.textContent?.replaceAll(/\s+/g, " ").trim(), href: link.getAttribute("href"),
    })));
    assert.deepEqual(workspaceLinks.slice(0, 5), [
      { label: "Home", href: "/" }, { label: "Projects", href: "/projects" }, { label: "Workers", href: "/workers" },
      { label: "Needs attention", href: "/needs-me" }, { label: "Settings", href: "/settings" },
    ]);
    assert.equal(workspaceLinks.some(link => link.label === "Idea LabOptional" && link.href === "/ideas"), profile.modules.ideaLab);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), true);

    await page.goto(`${origin}${projectPath}`, { waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { level: 1, name: profile.project }).waitFor();
    const newsLink = page.getByRole("navigation", { name: "Project pages" }).getByRole("link", { name: "News", exact: true });
    assert.equal(await newsLink.count(), profile.modules.news ? 1 : 0);
    if (profile.modules.news) assert.equal(await newsLink.getAttribute("href"), `${projectPath}/news`);
    assert.equal(await page.getByRole("heading", { level: 2, name: "Session observations" }).count(),
      profile.modules.sessionObservations ? 1 : 0);
    if (profile.modules.sessionObservations) {
      await page.getByText("No session observer is configured for this project.", { exact: true }).waitFor();
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), true);

    await page.goto(`${origin}/settings`, { waitUntil: "domcontentloaded" });
    await page.getByText(profile.template, { exact: true }).waitFor();
    settingsText = (await page.locator("main#private-main").innerText()).replaceAll(/\s+/g, " ");
    assert.ok(settingsText.includes(profile.displayName));
    assert.ok(settingsText.includes(profile.timezone));
    const enabledLabels = ["Idea Lab", "News and research", "Session observations"];
    for (const label of enabledLabels) assert.equal(settingsText.includes(label), profile.modules[{
      "Idea Lab": "ideaLab", "News and research": "news", "Session observations": "sessionObservations",
    }[label]]);
    assert.equal(settingsText.includes("Enabled modules None"), !Object.values(profile.modules).some(Boolean));
    assert.doesNotMatch(settingsText, /password|api key|secret key/i);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), true);
    layoutEvidence[layoutName] = { viewport, workspaceLinks, menuVisible: await menu.isVisible() };
  }
  await context.close();
  process.stdout.write(JSON.stringify({ profile: requestedProfile, displayName, modules: profile.modules, projects,
    settingsText, layouts: layoutEvidence, optionalRouteStatuses }));
} finally {
  if (browser) await browser.close().catch(() => {});
  if (application) await application.close().catch(() => {});
  else await disposable.db.close().catch(() => {});
}
