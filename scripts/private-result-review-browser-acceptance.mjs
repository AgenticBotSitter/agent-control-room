#!/usr/bin/env node
// Real-browser acceptance for compiled result reading and owner review.
// All records, result bytes, keys and checkpoints are disposable fixtures.
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
  console.error("private-result-review-browser-acceptance: Playwright not found. Set PLAYWRIGHT_MODULE to an existing Playwright installation.");
  process.exit(2);
}

const { default: handler } = await import("../dist-vps/server/index.js");
const { installPrivateWebProcess } = await import("../dist-vps/server/runtime.js");
const { loadPrivateClientAssets } = await import("../dist-vps/server/serving.js");
const { ownerReviewFixture } = await import("../tests/helpers/web-owner-review.ts");
const { binding, instant } = await import("../tests/hermes-native-fixture.ts");
const { origin } = await import("../tests/helpers/web-foundation.ts");

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

const fixture = await ownerReviewFixture();
const assets = await loadPrivateClientAssets(await realpath("dist-vps/client"));
let application;
let browser;
const posts = [];
// Result content is fetched with GET, so a POST-only log cannot observe it.
// Record content reads separately or the refusal check below proves nothing.
const contentReads = [];

try {
  application = installPrivateWebProcess({ ...fixture.accessTrust, origin,
    tenantId: binding.tenantId, workspaceId: fixture.scope.workspaceId,
    tasks: fixture.ownerKeys, loadKeys: async () => fixture.accessTrust.keys,
    database: { client: fixture.db, close: fixture.close }, clock: () => instant + 6000 });

  browser = await playwright.chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 360, height: 844 } });
  await context.route("**/*", async route => {
    const browserRequest = route.request(), url = new URL(browserRequest.url());
    if (url.origin !== origin) { await route.abort("blockedbyclient"); return; }
    const headers = new Headers(browserRequest.headers());
    headers.set("cf-access-jwt-assertion", fixture.jwt);
    headers.set("accept", headers.get("accept") ?? "text/html");
    if (!["GET", "HEAD"].includes(browserRequest.method())) headers.set("origin", origin);
    const body = browserRequest.postDataBuffer();
    if (browserRequest.method() === "GET" && /\/results\/[^/]+$/.test(url.pathname)) {
      contentReads.push(url.pathname);
    }
    if (browserRequest.method() === "POST" && url.pathname.startsWith("/api/")) {
      posts.push(Object.freeze({ path: url.pathname, body: body?.toString("utf8") ?? "",
        idempotencyKey: headers.get("idempotency-key") }));
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
  const taskPath = `/projects/${encodeURIComponent(binding.projectId)}/tasks/${encodeURIComponent(binding.jobId)}`;
  await page.goto(`${origin}${taskPath}`, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Result files" }).waitFor();
  await checkNoPageOverflow(page, "result task page");
  check("compiled task page lists the returned result", await page.getByRole("button", { name: "Read result" }).isVisible());
  check("returned text is not displayed before the owner opens it",
    await page.getByText("A useful private result.", { exact: true }).count() === 0);

  await page.getByRole("button", { name: "Read result" }).click();
  const resultRegion = page.getByRole("region", { name: "Protected result content" });
  await resultRegion.waitFor();
  await checkNoPageOverflow(page, "opened protected result");
  check("owner can read the exact protected result",
    await resultRegion.locator('textarea[aria-label="Agent result text"]').inputValue() === "A useful private result.");
  check("open result is clearly separated from executable instructions",
    await page.getByText(/Agent-written content, not instructions for Control Room/).isVisible());

  const feedback = "Add a clear setup example and return the revised result for review.";
  await page.getByRole("textbox", { name: "Changes you want" }).fill(feedback);
  await page.getByRole("button", { name: "Request changes" }).click();
  await page.getByRole("status").filter({ hasText: "Saved: changes requested" }).waitFor();
  check("owner change request is confirmed without starting new work", true);
  await checkNoPageOverflow(page, "saved owner review");

  const reviewPosts = posts.filter(entry => /\/reviews\/[^/]+$/.test(entry.path));
  check("quality decision crossed the command boundary exactly once", reviewPosts.length === 1,
    `posts=${reviewPosts.length}`);
  check("quality decision carried one retained command key",
    typeof reviewPosts[0]?.idempotencyKey === "string" && reviewPosts[0].idempotencyKey.length >= 8);
  check("quality decision sent the exact owner feedback",
    JSON.parse(reviewPosts[0]?.body ?? "{}").feedback === feedback);

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Result files" }).waitFor();
  await page.getByRole("button", { name: "Read result" }).click();
  await page.getByRole("region", { name: "Owner quality decision" }).waitFor();
  await checkNoPageOverflow(page, "reloaded owner review");
  check("saved change request survives a full browser reload",
    await page.getByText("Saved request for changes", { exact: false }).isVisible()
      && await page.getByText(feedback, { exact: true }).isVisible());
  check("saved decision cannot be mistaken for execution approval",
    await page.getByText(/does not authorize external actions or start another agent run/).isVisible());
  check("reload did not repeat the quality command",
    posts.filter(entry => /\/reviews\/[^/]+$/.test(entry.path)).length === 1);

  // Exact-artifact navigation: the selection lives in the URL, so it must
  // survive a reload and move with back/forward, and an unlisted ID must never
  // be read.
  const resultRegionByName = page.getByRole("region", { name: "Protected result content" });
  const openArtifactId = await page.getByRole("region", { name: "Protected result content" })
    .locator("code").first().innerText();

  await page.goto(`${origin}${taskPath}?result=${encodeURIComponent(openArtifactId)}#task-results`,
    { waitUntil: "domcontentloaded" });
  await resultRegionByName.waitFor();
  check("an exact result URL opens that file without another click",
    await resultRegionByName.locator('textarea[aria-label="Agent result text"]').inputValue()
      === "A useful private result.");
  await checkNoPageOverflow(page, "exact result URL");

  await page.reload({ waitUntil: "domcontentloaded" });
  await resultRegionByName.waitFor();
  check("the open file survives a full browser reload", await resultRegionByName.isVisible());

  await page.getByRole("button", { name: "Close result" }).click();
  check("closing the file clears it from the address bar",
    !new URL(page.url()).searchParams.has("result"));
  await page.goBack({ waitUntil: "domcontentloaded" });
  await resultRegionByName.waitFor();
  check("browser Back reopens the previously open file", await resultRegionByName.isVisible());

  const readsBefore = contentReads.length;
  await page.goto(`${origin}${taskPath}?result=${encodeURIComponent("artifact:not-in-this-task")}#task-results`,
    { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Result files" }).waitFor();
  check("an unlisted result ID is refused without reading anything",
    await page.getByText(/is not in this task’s authorized file list/).isVisible()
      && await resultRegionByName.count() === 0);
  check("the refused ID is dropped from the address bar",
    !new URL(page.url()).searchParams.has("result"));
  check("the refused ID produced no content read", contentReads.length === readsBefore,
    `content reads before=${readsBefore} after=${contentReads.length}`);
  await checkNoPageOverflow(page, "refused result selection");

  await context.close();
  console.log(`# ${checks.filter(value => value.passed).length}/${checks.length} checks passed; no listener, remote request or native agent was created`);
} finally {
  if (browser) await browser.close().catch(() => {});
  if (application) await application.close().catch(() => {});
  else await fixture.close().catch(() => {});
}
