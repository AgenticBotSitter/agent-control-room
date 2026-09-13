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
  research: Object.freeze({ displayName: "Research Room", timezone: "America/Denver", ideaLab: true,
    template: "Research projects", project: "Research-only browser project" }),
  operations: Object.freeze({ displayName: "Operations Room", timezone: "UTC", ideaLab: false,
    template: "Operations projects", project: "Operations-only browser project" }),
});

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
  assert.equal(research.ideaLabVisible, true);
  assert.equal(operations.ideaLabVisible, false);
  assert.deepEqual(research.projects, [profiles.research.project]);
  assert.deepEqual(operations.projects, [profiles.operations.project]);
  assert.ok(!research.settingsText.includes(profiles.operations.displayName));
  assert.ok(!operations.settingsText.includes(profiles.research.displayName));
  assert.ok(!research.projects.includes(profiles.operations.project));
  assert.ok(!operations.projects.includes(profiles.research.project));
  console.log("ok - one compiled artifact rendered two distinct product names and module selections");
  console.log("ok - each separately configured process retained only its own disposable project data");
  console.log("ok - settings and navigation exposed only the selected non-secret configuration");
  console.log("# 3/3 two-configuration browser checks passed; no listener, remote request or native agent was created");
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
  modules: { ideaLab: profile.ideaLab, news: false, sessionObservations: false },
  limits: { maxProjects: 12, maxTasksPerProject: 100, maxResultsPerTask: 20, maxArticleSources: 0, maxIdeaParticipants: profile.ideaLab ? 6 : 0 },
  projectTemplates: [{ id: requestedProfile, displayName: profile.template, enabledModules: profile.ideaLab ? ["ideaLab"] : [] }],
};
let application;
let browser;
try {
  application = installPrivateWebProcess({ origin, ...trust, tenantId: "tenant:web", workspaceId: "workspace:web",
    database: { client: disposable.client, close: () => disposable.db.close() }, clock: () => now,
    loadKeys: async () => trust.keys, productConfiguration });
  browser = await playwright.chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 900, height: 800 } });
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
  const ideaLabVisible = await page.getByRole("navigation", { name: "Workspace pages" })
    .getByRole("link", { name: /Idea Lab/ }).count() === 1;

  await page.goto(`${origin}/projects`, { waitUntil: "domcontentloaded" });
  await page.locator("#project-title").fill(profile.project);
  await page.locator("#project-summary").fill(`Disposable data for the ${profile.displayName} configuration.`);
  await page.getByRole("button", { name: "Create project" }).click();
  await page.getByRole("heading", { level: 1, name: profile.project }).waitFor();
  await page.goto(`${origin}/projects`, { waitUntil: "domcontentloaded" });
  await page.getByText(profile.project, { exact: true }).first().waitFor();
  const projects = (await page.locator(".private-project-grid h3").allTextContents()).map(value => value.trim());

  await page.goto(`${origin}/settings`, { waitUntil: "domcontentloaded" });
  await page.getByText(profile.template, { exact: true }).waitFor();
  const settingsText = (await page.locator("main#private-main").innerText()).replaceAll(/\s+/g, " ");
  assert.ok(settingsText.includes(profile.displayName));
  assert.ok(settingsText.includes(profile.timezone));
  assert.equal(settingsText.includes("Idea Lab"), profile.ideaLab);
  await context.close();
  process.stdout.write(JSON.stringify({ profile: requestedProfile, displayName, ideaLabVisible, projects, settingsText }));
} finally {
  if (browser) await browser.close().catch(() => {});
  if (application) await application.close().catch(() => {});
  else await disposable.db.close().catch(() => {});
}
