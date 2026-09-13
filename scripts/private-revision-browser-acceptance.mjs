#!/usr/bin/env node
// Real-browser acceptance for one saved owner change request becoming one
// proposed follow-up task. All identities, data, keys and results are disposable.
// No listener, remote request, production configuration or native agent is used.

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
  console.error("private-revision-browser-acceptance: Playwright not found. Set PLAYWRIGHT_MODULE to an existing Playwright installation.");
  process.exit(2);
}

const { default: handler } = await import("../dist-vps/server/index.js");
const { createPrivateTaskBootstrap } = await import("../dist-vps/server/taskBootstrap.js");
const { installPrivateApplication } = await import("../dist-vps/server/runtime.js");
const { loadPrivateClientAssets } = await import("../dist-vps/server/serving.js");
const { nativeQualityCompletionFixture } = await import("../tests/helpers/native-quality-completion.ts");
const { taskStartupFixture } = await import("../tests/helpers/task-startup.ts");
const { origin } = await import("../tests/helpers/web-foundation.ts");
const { CanonicalStore } = await import("../src/persistence/canonical-store.ts");

const checks = [];
function check(name, condition, detail = "") {
  checks.push({ name, passed: Boolean(condition) });
  console.log(`${condition ? "ok" : "not ok"} - ${name}${detail ? ` # ${detail}` : ""}`);
  assert.ok(condition, name);
}

const fixture = await nativeQualityCompletionFixture();
let startup;
let runtime;
let browser;
const posts = [];

try {
  startup = await taskStartupFixture(fixture.f.assignmentFixture);
  const assets = await loadPrivateClientAssets(await realpath("dist-vps/client"));
  runtime = await createPrivateTaskBootstrap({ clock: fixture.f.clock, install: installPrivateApplication,
    openDatabase: startup.openDatabase }).start({ ...startup.config, coordinator: { ...startup.config.coordinator,
      quality: { ...fixture.f.ownerConfig, scenarios: [fixture.scenario] }, revisionPlanning: true } });
  check("compiled application exposes revision preparation", runtime.isReady() && Boolean(runtime.revisions));

  browser = await playwright.chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.route("**/*", async route => {
    const browserRequest = route.request(), url = new URL(browserRequest.url());
    if (url.origin !== origin) { await route.abort("blockedbyclient"); return; }
    const headers = new Headers(browserRequest.headers());
    headers.set("cf-access-jwt-assertion", fixture.f.jwt);
    headers.set("accept", headers.get("accept") ?? "text/html");
    if (!["GET", "HEAD"].includes(browserRequest.method())) headers.set("origin", origin);
    const body = browserRequest.postDataBuffer();
    if (browserRequest.method() === "POST" && url.pathname.startsWith("/api/")) {
      posts.push(Object.freeze({ path: url.pathname, body: body?.toString("utf8") ?? "" }));
    }
    const staticResponse = (url.pathname.startsWith("/_next/") || url.pathname === "/favicon.svg") && !url.search
      ? assets.respond(url.pathname, browserRequest.method()) : undefined;
    const response = staticResponse ?? await handler(new Request(browserRequest.url(), {
      method: browserRequest.method(), headers,
      ...(!["GET", "HEAD"].includes(browserRequest.method()) && body ? { body } : {}),
    }));
    const responseBody = browserRequest.method() === "HEAD" ? Buffer.alloc(0) : Buffer.from(await response.arrayBuffer());
    await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: responseBody });
  });

  const page = await context.newPage();
  const projectId = fixture.registration.projectId, sourceJobId = fixture.registration.jobId;
  const sourcePath = `/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(sourceJobId)}`;
  await page.goto(`${origin}${sourcePath}`, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Result files" }).waitFor();
  await page.getByRole("button", { name: "Read result" }).click();
  await page.getByRole("region", { name: "Protected result content" }).waitFor();

  const feedback = "Prepare a clearer explanation of the recorded evidence.";
  await page.getByRole("textbox", { name: "Changes you want" }).fill(feedback);
  await page.getByRole("button", { name: "Request changes" }).click();
  await page.getByRole("status").filter({ hasText: "Saved: changes requested" }).waitFor();
  await page.getByRole("button", { name: "Prepare revised task" }).waitFor();
  check("saved owner feedback enables one explicit follow-up preparation", true);

  const nativeCalls = [...fixture.local.calls], nativeEffects = fixture.local.effects.countFull();
  await page.getByRole("button", { name: "Prepare revised task" }).click();
  const prepared = page.getByRole("status").filter({ hasText: "Revision 1 is prepared" });
  await prepared.waitFor();
  const childLink = prepared.getByRole("link", { name: "Open revised task" });
  const childHref = await childLink.getAttribute("href");
  check("browser receives a distinct linked follow-up task", typeof childHref === "string" && childHref !== sourcePath);

  const reviewPosts = posts.filter(entry => /\/reviews\/[^/]+$/.test(entry.path));
  const revisionPosts = posts.filter(entry => entry.path.endsWith("/revisions"));
  check("browser sent one review and one revision preparation", reviewPosts.length === 1 && revisionPosts.length === 1,
    `reviews=${reviewPosts.length}; revisions=${revisionPosts.length}`);
  check("follow-up uses the exact saved owner feedback", JSON.parse(revisionPosts[0]?.body ?? "{}").feedback === feedback);

  const childJobId = decodeURIComponent(childHref.split("/").at(-1));
  const canonical = new CanonicalStore(startup.coordinator.client);
  const child = await canonical.get(fixture.request.tenantId, "job", childJobId);
  await childLink.click();
  await page.waitForURL(url => url.pathname === childHref);
  await page.getByRole("heading", { name: "Agent progress", exact: true }).waitFor();
  check("prepared follow-up has a working direct task page", page.url().endsWith(childHref));

  const attempts = await startup.coordinator.client.query("SELECT id FROM control_attempts WHERE job_id=$1", [childJobId]);
  check("follow-up remains proposed and starts no agent", child.state === "proposed" && attempts.rows.length === 0);
  check("browser actions caused no native call or external effect",
    JSON.stringify(fixture.local.calls) === JSON.stringify(nativeCalls) && fixture.local.effects.countFull() === nativeEffects);

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Agent progress", exact: true }).waitFor();
  check("follow-up direct link survives a full browser reload", page.url().endsWith(childHref));
  check("reload does not repeat either command", posts.filter(entry => /\/reviews\/[^/]+$/.test(entry.path)).length === 1
    && posts.filter(entry => entry.path.endsWith("/revisions")).length === 1);

  await context.close();
  console.log(`# ${checks.filter(value => value.passed).length}/${checks.length} checks passed; no listener, remote request or native agent was created`);
} finally {
  if (browser) await browser.close().catch(() => {});
  if (runtime) await runtime.close().catch(() => {});
  else if (startup) await Promise.allSettled([startup.web.close(), startup.coordinator.close()]);
  await fixture.close().catch(() => {});
}
