#!/usr/bin/env node
// Browser journey acceptance for the issue #208 workflow shells.
//
// The compiled private application is driven through Playwright against the built
// Request handler with route interception: no listener, no remote request, no
// production credential and no native agent. All state lives in one disposable
// PGlite database, seeded through the real stores the product uses.
//
// This lane exists because the issue's acceptance requires the compiled product to
// prove back/forward/reload, keyboard operation and 360px/1280px behaviour for the
// Idea Lab and article-to-research journeys and for the private shell change in
// `private-app/app/idea-workspace.tsx` / `news-workspace.tsx`. The private
// accessibility lane still expects the pre-fix defect state for those two pages, so
// its 541/541 run is not evidence for them; this script measures the pages itself.
//
// Usage:
//   pnpm build
//   PLAYWRIGHT_MODULE=/absolute/path/to/playwright \
//     node --import tsx scripts/workflow-journeys/browser-journeys.mjs
//
// Optional: PRIVATE_BROWSER_SCREENSHOT_DIR=/absolute/dir writes sanitized screenshots.

import assert from "node:assert/strict";
import { mkdir, readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { isAbsolute, relative, resolve } from "node:path";

const requireFromRepo = createRequire(resolve("package.json"));
let playwright;
for (const candidate of [process.env.PLAYWRIGHT_MODULE, "playwright"]) {
  if (!candidate) continue;
  try { playwright = requireFromRepo(candidate); break; } catch { /* try the next explicit candidate */ }
}
if (!playwright) {
  console.error("browser-journeys: Playwright not found. Set PLAYWRIGHT_MODULE to an existing Playwright installation.");
  process.exit(2);
}

const requestedScreenshotDirectory = process.env.PRIVATE_BROWSER_SCREENSHOT_DIR;
let screenshotDirectory;
if (requestedScreenshotDirectory) {
  assert.ok(isAbsolute(requestedScreenshotDirectory), "PRIVATE_BROWSER_SCREENSHOT_DIR must be an absolute path");
  // Normalize once: `resolve` gives the native separator, so the containment check below
  // compares like with like on Windows (forward slashes in the environment variable).
  screenshotDirectory = resolve(requestedScreenshotDirectory);
  await mkdir(screenshotDirectory, { recursive: true });
}

const { default: handler } = await import("../../dist-vps/server/index.js");
const { installPrivateWebProcess } = await import("../../dist-vps/server/runtime.js");
const { loadPrivateClientAssets } = await import("../../dist-vps/server/serving.js");
const { fixture, now, origin, token, trust } = await import("../../tests/helpers/web-foundation.ts");
const { createAccessVerifier } = await import("../../src/web/v1/access-verifier.ts");
const { sha256Digest } = await import("../../src/security/index.ts");
const { buildIdeaLabSessionV1 } = await import("../../src/idea-lab/v1/contracts.ts");
const { IdeaLabProjectRegistryStoreV1 } = await import("../../src/idea-lab/v1/store.ts");
const { IdeaLabBotRunStoreV1 } = await import("../../src/idea-lab/v1/coordinator-store.ts");
const { IdeaLabBotCoordinatorV1, DeterministicIdeaLabFakeDriverV1, buildRepositoryFakeProviderEvidenceV1 } =
  await import("../../src/idea-lab/v1/coordinator.ts");
const { DeterministicIdeaLabSynthesisEngineV1 } = await import("../../src/idea-lab/v1/synthesis-engine.ts");
const { CONTROL_ROOM_IDEA_ADAPTER_V1 } = await import("../../src/idea-lab/v1/schemas.ts");
const { buildNewsStoryV1 } = await import("../../src/project-adapters/news/v1/story.ts");
const { PostgresNewsStoreV1 } = await import("../../src/project-adapters/news/v1/postgres-store.ts");
// The authoring operations the private process is normally installed with (see
// src/web/v1/private-idea-authoring-startup.ts). They are constructed here against the
// one disposable database instead of two production pools, so the compiled product can
// render and save the owner decision this journey drives.
const { IdeaSessionCreationService } = await import("../../src/web/v1/idea-create-operation.ts");
const { WebIdeaSynthesisOperation } = await import("../../src/web/v1/idea-synthesis-operation.ts");
const { WebIdeaDecisionOperation } = await import("../../src/web/v1/idea-decision-operation.ts");

const checks = [];
function check(name, condition, detail = "") {
  checks.push({ name, passed: Boolean(condition) });
  console.log(`${condition ? "ok" : "not ok"} - ${name}${detail ? ` # ${detail}` : ""}`);
  assert.ok(condition, `${name}${detail ? `: ${detail}` : ""}`);
}

// Target-size predicate copied from the private accessibility lane: the rect already
// includes padding and border, so a visible enabled control below 24px is flagged.
const SMALL_TARGET_PREDICATE = `(element, visible, getComputedStyle) => {
  if (!visible(element) || element.disabled) return false;
  const box = element.getBoundingClientRect();
  return box.width < 24 || box.height < 24;
}`;

async function inspectShell(page) {
  return page.evaluate(predicateSrc => {
    const isSmallTarget = eval(predicateSrc);
    const visible = element => {
      const style = getComputedStyle(element);
      return style.visibility !== "hidden" && style.display !== "none" && element.getClientRects().length > 0;
    };
    const shell = document.querySelectorAll("div.private-shell");
    const main = document.querySelectorAll(".private-shell main#private-main");
    const current = [...document.querySelectorAll('[aria-current="page"]')].map(element => element.textContent?.trim() ?? "");
    const smallTargets = [...document.querySelectorAll("button, a[href], summary")]
      .filter(element => isSmallTarget(element, visible, getComputedStyle))
      .map(element => `${element.tagName.toLowerCase()}:${(element.textContent || "").trim().slice(0, 40)}`);
    return { shellCount: shell.length, mainInsideShell: main.length, current, smallTargets,
      scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth };
  }, SMALL_TARGET_PREDICATE);
}

async function saveSanitizedScreenshot(page, filename, maximumWidth, maximumHeight) {
  if (!screenshotDirectory) return;
  const path = resolve(screenshotDirectory, filename);
  const inside = relative(screenshotDirectory, path);
  assert.ok(inside && !inside.startsWith("..") && !isAbsolute(inside), "screenshot path must remain inside the supplied directory");
  await page.screenshot({ path, fullPage: false, animations: "disabled" });
  const image = await readFile(path);
  const isPng = image.length >= 24 && image.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"));
  const width = isPng ? image.readUInt32BE(16) : 0;
  const height = isPng ? image.readUInt32BE(20) : 0;
  check(`sanitized ${filename} was written as a bounded PNG`, isPng && image.length <= 5 * 1024 * 1024
    && width <= maximumWidth && height <= maximumHeight, `${width}x${height}; bytes=${image.length}`);
}

// ---------------------------------------------------------------------------
// Disposable state, seeded through the real stores the product reads.
// ---------------------------------------------------------------------------
const fixtureNow = new Date(now).toISOString();
const ideaKey = new Uint8Array(32).fill(0x42);
const newsKey = new Uint8Array(32).fill(0x24);
const disposable = await fixture();
const identity = createAccessVerifier(trust)(new Request(`${origin}/api/v1/projects`, { method: "GET",
  headers: { "cf-access-jwt-assertion": token(), origin } }), now);
const tenantId = "tenant:web", workspaceId = "workspace:web";

const newsProject = await disposable.service.create(identity,
  { title: "News workflow project", summary: "Disposable project proving the article-to-research journey." },
  "browser-journey-project-news-001");
const emptyProject = await disposable.service.create(identity,
  { title: "Empty news project", summary: "Isolation control: an active project with no saved stories." },
  "browser-journey-project-empty-001");
const newsScope = { tenantId, workspaceId, projectId: newsProject.project.projectId };
const story = buildNewsStoryV1({ ...newsScope, storyId: "story:browser-journey", clusterId: "cluster:browser-journey",
  queue: "important_now", title: "Browser journey article", summary: "A saved article the product must list, with its source retained.",
  canonicalUrl: "https://example.invalid/browser-journey", sourceLabel: "Browser Journey Source",
  publishedAt: fixtureNow, discoveredAt: fixtureNow, lastVerifiedAt: fixtureNow, verificationState: "verified",
  priorityScore: 70, coverageCount: 1, contentDigest: `sha256:${"a".repeat(64)}`,
  sourceEvidence: [{ evidenceId: "evidence:browser-journey", sourceId: "source:browser-journey", sourceKind: "manual",
    sourceLabel: "Browser Journey Source", canonicalUrl: "https://example.invalid/browser-journey", observedAt: fixtureNow,
    evidenceDigest: `sha256:${"a".repeat(64)}`, containsRawNewsletterBody: false, grantsNetworkAuthority: false }] });
const savedStories = await new PostgresNewsStoreV1(disposable.client, newsScope, newsKey, () => new Date(now)).saveStories([story]);
assert.equal(savedStories.inserted, 1);

const panel = { sessionId: "idea-session:browser-journey", title: "Browser journey panel",
  ideaSummary: "A bounded panel that must render its retained, attributed contributions.",
  targetCustomer: "Owner-operators who must see who said what, and which turn was lost." };
const registry = new IdeaLabProjectRegistryStoreV1(disposable.client, ideaKey);
const ledger = new IdeaLabBotRunStoreV1(disposable.client, ideaKey);
await disposable.client.query(`INSERT INTO adapter_registry(id,tenant_id,source_system,contract_version,authority_mode,status,redaction_policy_version,cursor_retention_days)
  VALUES($1,$2,'control_room_native_ideas','1.0.0','control_room_native','fixture','v1',30)`, [CONTROL_ROOM_IDEA_ADAPTER_V1, tenantId]);
const participants = [
  { participantId: "bot:buyer", displayName: "Buyer Lens", perspective: "customer", harness: "hermes", modelClass: "reasoning", platform: "windows" },
  { participantId: "bot:market", displayName: "Market Scout", perspective: "market", harness: "hermes", modelClass: "research", platform: "linux" },
  { participantId: "bot:red-team", displayName: "Red Team", perspective: "skeptic", harness: "codex", modelClass: "reasoning", platform: "macos" },
].map(item => ({ ...item, identityDigest: sha256Digest({ panel: panel.sessionId, participantId: item.participantId }),
  sourceMode: "injected_only", liveConnected: false, canDispatch: false }));
const buildSession = (sessionId, title = panel.title) => buildIdeaLabSessionV1({ sessionId, tenantId, workspaceId, title,
  ideaSummary: panel.ideaSummary, targetCustomer: panel.targetCustomer, participants, maxRounds: 2, maxDurationSeconds: 600,
  maxCostUsd: 4, createdByIdentityDigest: sha256Digest({ panel: panel.sessionId, role: "owner" }), createdAt: fixtureNow });
const completedSession = buildSession(panel.sessionId);
await registry.registerSession(completedSession);
const evidenceFor = session => session.participants.map((participant, index) => buildRepositoryFakeProviderEvidenceV1(session, participant,
  { evidenceId: `evidence:${session.sessionId}:${index}`, capturedAt: fixtureNow, expiresAt: new Date(now + 120000).toISOString() }));
const completedRun = await new IdeaLabBotCoordinatorV1(ledger, registry, new DeterministicIdeaLabFakeDriverV1(), () => fixtureNow)
  .execute({ runId: "run:browser-journey-completed", session: completedSession, evidence: evidenceFor(completedSession),
    safePrompt: "Compare this idea from every assigned perspective and name one bounded experiment." });
assert.equal(completedRun.state, "completed");
const completedContributions = await registry.listContributions(tenantId, completedSession.sessionId);
const synthesis = new DeterministicIdeaLabSynthesisEngineV1().build(completedSession, completedContributions, fixtureNow);
await registry.recordSynthesis(synthesis);

const interruptedTitle = `${panel.title} (interrupted run)`;
const interruptedSession = buildSession(`${panel.sessionId}-interrupted`, interruptedTitle);
await registry.registerSession(interruptedSession);
const interruptedRun = await new IdeaLabBotCoordinatorV1(ledger, registry,
  new DeterministicIdeaLabFakeDriverV1({ "bot:red-team:2": "throw" }), () => fixtureNow)
  .execute({ runId: "run:browser-journey-interrupted", session: interruptedSession, evidence: evidenceFor(interruptedSession),
    safePrompt: "Compare this idea from every assigned perspective and name one bounded experiment." });
assert.equal(interruptedRun.state, "ambiguous", "the lost provider outcome must stay uncertain");

let application, browser;
const posts = [];
const nonOkResponses = [];
const assets = await loadPrivateClientAssets(await realpath("dist-vps/client"));
const path = suffix => `/projects/${encodeURIComponent(newsProject.project.projectId)}${suffix}`;

async function installProtectedRequestRouting(context) {
  await context.route("**/*", async route => {
    const browserRequest = route.request();
    const url = new URL(browserRequest.url());
    if (url.origin !== origin) { await route.abort("blockedbyclient"); return; }
    const headers = new Headers(browserRequest.headers());
    headers.set("cf-access-jwt-assertion", token());
    headers.set("accept", headers.get("accept") ?? "text/html");
    if (!["GET", "HEAD"].includes(browserRequest.method())) headers.set("origin", origin);
    const body = browserRequest.postDataBuffer();
    if (browserRequest.method() === "POST" && url.pathname.startsWith("/api/")) {
      posts.push(Object.freeze({ path: url.pathname, body: body?.toString("utf8") ?? "", idempotencyKey: headers.get("idempotency-key") }));
      console.log(`# browser command ${url.pathname}`);
    }
    // The compiled application is reached through Playwright route interception: client
    // assets come from dist-vps/client and every document/API request goes to the built
    // request handler. No listener, socket, DNS lookup or remote request is created.
    const staticResponse = (url.pathname.startsWith("/_next/") || url.pathname === "/favicon.svg") && !url.search
      ? assets.respond(url.pathname, browserRequest.method()) : undefined;
    const response = staticResponse ?? await handler(new Request(browserRequest.url(), { method: browserRequest.method(), headers,
      ...(!["GET", "HEAD"].includes(browserRequest.method()) && body ? { body } : {}) }));
    const responseBody = browserRequest.method() === "HEAD" ? Buffer.alloc(0) : Buffer.from(await response.arrayBuffer());
    await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: responseBody });
  });
}

try {
  const ideaScope = { tenantId, workspaceId };
  const creation = new IdeaSessionCreationService(disposable.client, ideaScope, ideaKey, participants, () => now);
  const synthesisOperation = new WebIdeaSynthesisOperation(disposable.client, ideaScope, ideaKey, () => now);
  const decisionOperation = new WebIdeaDecisionOperation(disposable.client, ideaScope, ideaKey, () => now);
  const ideaCreation = Object.freeze({ ...ideaScope, options: creation.options.bind(creation), create: creation.create.bind(creation),
    synthesize: synthesisOperation.synthesize.bind(synthesisOperation), decide: decisionOperation.decide.bind(decisionOperation) });
  application = installPrivateWebProcess({ origin, ...trust, tenantId, workspaceId,
    database: { client: disposable.client, close: async () => {} }, clock: () => now, loadKeys: async () => trust.keys,
    ideaProjects: { integrityKey: ideaKey }, ideaCreation, news: { integrityKey: newsKey } });

  browser = await playwright.chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 360, height: 844 } });
  await installProtectedRequestRouting(context);
  const page = await context.newPage();
  page.on("pageerror", error => console.error(`# page error ${error.message}`));
  page.on("console", message => { if (message.type() === "error") console.error(`# console error ${message.text()}`); });
  // Every non-2xx response is recorded: the shell's product-configuration read stays
  // unconfigured in this lane (the existing private browser lanes do the same), so any
  // other failing route must be named by the closing check rather than pass unnoticed.
  page.on("response", response => { if (response.status() >= 400)
    nonOkResponses.push(`${response.status()} ${new URL(response.url()).pathname}`); });

  // --- Idea Lab journey at 360px -------------------------------------------
  await page.goto(`${origin}/ideas`, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Idea Lab", level: 1 }).waitFor();
  const ideasList = await inspectShell(page);
  check("ideas list renders inside the shared private shell", ideasList.shellCount === 1 && ideasList.mainInsideShell === 1,
    `shell=${ideasList.shellCount} mainInsideShell=${ideasList.mainInsideShell}`);
  check("ideas list announces exactly one current page", ideasList.current.length === 1 && ideasList.current[0] === "All saved ideas",
    JSON.stringify(ideasList.current));
  check("ideas list controls meet the 24px minimum target at 360px", ideasList.smallTargets.length === 0,
    ideasList.smallTargets.join(" | "));
  check("ideas list does not scroll sideways at 360px", ideasList.scrollWidth <= ideasList.clientWidth + 1,
    `${ideasList.scrollWidth}px of ${ideasList.clientWidth}px`);
  await page.locator("body").focus();
  await page.keyboard.press("Tab");
  check("skip link is the first keyboard target on the ideas list", await page.locator(":focus").evaluate(element =>
    element.matches("a.skip-link") && element.textContent?.trim() === "Skip to content"));
  const savedIdea = page.getByRole("link", { name: panel.title, exact: true });
  const completedCard = page.locator("article.private-panel").filter({ has: savedIdea });
  const completedCardText = await completedCard.innerText();
  check("the completed panel is listed exactly once with its participants and round bound",
    await savedIdea.count() === 1 && await completedCard.count() === 1
    && completedCardText.includes("3 participants · Up to 2 rounds"),
    `links=${await savedIdea.count()} cards=${await completedCard.count()} text=${completedCardText.slice(0, 200).replace(/\n/g, " / ")}`);

  // Keyboard-only navigation into the panel detail.
  await savedIdea.focus();
  await page.keyboard.press("Enter");
  await page.waitForURL(url => url.pathname.startsWith("/ideas/"));
  await page.getByRole("heading", { name: panel.title, level: 1 }).waitFor();
  check("keyboard activation of the panel link opens its protected detail", true, new URL(page.url()).pathname);

  const panelText = await page.locator("main").innerText();
  check("panel detail states the completed run and its turn count",
    panelText.includes("Discussion completed") && panelText.includes("6 of"), panelText.slice(0, 160).replace(/\n/g, " / "));
  check("panel detail attributes every retained contribution to its participant",
    panelText.includes("Buyer Lens · customer") && panelText.includes("Market Scout · market") && panelText.includes("Red Team · skeptic")
    && (await page.locator("section[aria-label='Round 1'] article").count()) === 3
    && (await page.locator("section[aria-label='Round 2'] article").count()) === 3);
  check("panel detail marks synthetic contributions instead of claiming provider contact",
    panelText.includes("Synthetic test contribution — no provider was contacted.") && panelText.includes("Provider contact has not been confirmed."));
  check("panel detail shows the recap and the owner decision form",
    panelText.includes("Advisory score:") && (await page.getByRole("heading", { name: "Your decision" }).count()) === 1
    && (await page.getByRole("button", { name: "Save my decision" }).count()) === 1);
  const panelShell = await inspectShell(page);
  check("panel detail renders inside the shared private shell with 24px controls at 360px",
    panelShell.shellCount === 1 && panelShell.mainInsideShell === 1 && panelShell.smallTargets.length === 0,
    panelShell.smallTargets.join(" | "));
  check("panel detail does not scroll sideways at 360px", panelShell.scrollWidth <= panelShell.clientWidth + 1,
    `${panelShell.scrollWidth}px of ${panelShell.clientWidth}px`);
  const panelPath = new URL(page.url()).pathname;

  // Back / forward through the panel history.
  await page.locator("nav[aria-label='Idea pages']").getByRole("link", { name: "All saved ideas" }).click();
  await page.getByRole("heading", { name: "Idea Lab", level: 1 }).waitFor();
  await page.goBack({ waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: panel.title, level: 1 }).waitFor();
  check("browser back returns from the list to the panel detail", new URL(page.url()).pathname === panelPath);
  await page.goForward({ waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Idea Lab", level: 1 }).waitFor();
  await page.goto(`${origin}${panelPath}`, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: panel.title, level: 1 }).waitFor();
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: panel.title, level: 1 }).waitFor();
  check("browser reload restores the panel detail with its status", (await page.locator("main").innerText()).includes("Discussion completed"));

  // Owner decision through the product UI.
  await page.getByLabel("Your choice").selectOption("create_project");
  await page.getByLabel("Project title").fill("Browser journey promoted project");
  await page.getByLabel("Project summary").fill("Promoted from the browser journey panel; no work may start.");
  const [decisionResponse] = await Promise.all([
    page.waitForResponse(response => new URL(response.url()).pathname.endsWith("/decision") && response.request().method() === "POST"),
    page.getByRole("button", { name: "Save my decision" }).click(),
  ]);
  const decisionBody = await decisionResponse.text();
  const decisionReceipt = JSON.parse(decisionBody);
  check("the owner decision is accepted by the compiled decision route",
    decisionResponse.status() === 201 && decisionReceipt.decision === "create_project"
    && decisionReceipt.replayed === false && decisionReceipt.startsWork === false
    && typeof decisionReceipt.projectId === "string",
    `${decisionResponse.status()} decision=${decisionReceipt.decision} replayed=${decisionReceipt.replayed} startsWork=${decisionReceipt.startsWork} project=${decisionReceipt.projectId}`);
  await page.getByText("Project created. No work has started.").waitFor();
  check("owner decision promotes the panel in the product UI",
    (await page.locator("main").innerText()).includes("Saved for later") === false
    && (await page.getByRole("link", { name: "Open project workspace" }).count()) === 1);
  await page.getByRole("link", { name: "Open project workspace" }).click();
  await page.getByRole("heading", { name: "Browser journey promoted project", level: 1 }).waitFor();
  check("promoted project opens its protected workspace", true, new URL(page.url()).pathname);
  await page.goBack({ waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: panel.title, level: 1 }).waitFor();
  check("browser back returns to the promoted panel without losing the decision",
    (await page.locator("main").innerText()).includes("Promoted to a project"));

  // Partial failure stays visible in the product.
  await page.goto(`${origin}/ideas/${encodeURIComponent(interruptedSession.sessionId)}`, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: interruptedTitle, level: 1 }).waitFor();
  const interruptedText = await page.locator("main").innerText();
  check("a lost provider outcome is shown as uncertain, not completed",
    interruptedText.includes("Outcome uncertain — do not restart") && interruptedText.includes("Automatic retry is disabled.")
    && interruptedText.includes("No contribution saved for this round."));

  // --- Article-to-research journey at 360px --------------------------------
  await page.goto(`${origin}${path("/news")}`, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "News workflow project · News", level: 1 }).waitFor();
  const newsShell = await inspectShell(page);
  check("project news renders inside the shared private shell", newsShell.shellCount === 1 && newsShell.mainInsideShell === 1,
    `shell=${newsShell.shellCount} mainInsideShell=${newsShell.mainInsideShell}`);
  check("project news controls meet the 24px minimum target at 360px", newsShell.smallTargets.length === 0,
    newsShell.smallTargets.join(" | "));
  check("project news does not scroll sideways at 360px", newsShell.scrollWidth <= newsShell.clientWidth + 1,
    `${newsShell.scrollWidth}px of ${newsShell.clientWidth}px`);
  check("the saved article is listed with its retained source",
    (await page.getByRole("heading", { name: "Browser journey article" }).count()) === 1
    && (await page.locator("main").innerText()).includes("Browser Journey Source"));

  const prepareButton = page.getByRole("button", { name: "Research, compare or draft" });
  await prepareButton.focus();
  await page.keyboard.press("Enter");
  await page.getByRole("region", { name: "Prepare article research" }).waitFor();
  check("keyboard activation of the article action opens the research form", true);
  await page.getByRole("button", { name: "Prepare draft" }).click();
  await page.getByRole("heading", { name: "Review the task before saving" }).waitFor();
  const draftText = await page.locator("main").innerText();
  check("the prepared draft keeps its article attribution before saving",
    draftText.includes("Story: story:browser-journey") && draftText.includes("https://example.invalid/browser-journey")
    && draftText.includes("This proposal does not authorize tools, network access, installation or publication."));
  await page.getByRole("button", { name: "Save proposed task" }).click();
  await page.getByText("Task saved for review. No bot has been started.").waitFor();
  check("the protected save reports a review-only task with no bot started",
    (await page.getByRole("link", { name: "Open saved task" }).count()) === 1);
  const preparePosts = posts.filter(entry => entry.path.endsWith("/news/prepare"));
  const taskPosts = posts.filter(entry => entry.path.endsWith("/tasks") || entry.path.endsWith("/tasks/from-news"));
  check("the article journey crossed the protected command boundary exactly twice",
    preparePosts.length === 1 && taskPosts.length === 1, JSON.stringify(posts.map(entry => entry.path)));
  check("the saved task command carried an idempotency key",
    taskPosts.every(entry => typeof entry.idempotencyKey === "string" && entry.idempotencyKey.length >= 8));
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Browser journey article" }).waitFor();
  check("browser reload keeps the saved article list", true);
  await page.setViewportSize({ width: 1280, height: 900 });
  const wideNews = await inspectShell(page);
  check("project news does not scroll sideways at 1280px", wideNews.scrollWidth <= wideNews.clientWidth + 1,
    `${wideNews.scrollWidth}px of ${wideNews.clientWidth}px`);
  await saveSanitizedScreenshot(page, "workflow-journeys-news-wide.png", 1280, 900);
  await page.setViewportSize({ width: 360, height: 844 });

  // Isolation: an active project with no saved stories must not show this project's story.
  await page.goto(`${origin}/projects/${encodeURIComponent(emptyProject.project.projectId)}/news`, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Empty news project · News", level: 1 }).waitFor();
  const emptyText = await page.locator("main").innerText();
  check("a second project shows its own empty news state and not the first project's article",
    emptyText.includes("No saved stories in this view on this page.") && !emptyText.includes("Browser journey article"));

  const unexpected = nonOkResponses.filter(entry => entry !== "404 /api/v1/product-configuration");
  check("no unexpected non-2xx response was observed", unexpected.length === 0,
    `${nonOkResponses.length} recorded; only the unconfigured product-configuration read is expected: ${unexpected.join(" | ")}`);
  await context.close();
  console.log(`# ${checks.filter(value => value.passed).length}/${checks.length} checks passed; no listener, remote request or native agent was created`);
} finally {
  if (browser) await browser.close().catch(() => {});
  if (application) await application.close().catch(() => {});
  else await disposable.db.close().catch(() => {});
}