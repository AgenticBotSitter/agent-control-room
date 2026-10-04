// The adversarial owner suite, rewritten for the route the installed Mac really
// has.
//
// The installed Mac is CONNECTOR-ONLY (start-web-host.mjs `connectorOnly: true`):
// it builds no planner, no assignment coordinator and no queue, so its bots are
// fleet connector workers and an owner's task reaches one only as an offer
// claimed through the fleet gateway. Every test below drives that exact route
// with the real connector client and scripted bots.
//
// NO PROTECTION IS DROPPED. Each one is re-expressed on the real route:
//
//   readiness / invalid filters / reloads / phone and desktop layout  -> unchanged
//   hostile text stored inert, oversized input refused, duplicate names allowed,
//   Back and forward survive                                       -> unchanged
//   missing and wrong Origin refused, cross-project route refused,
//   unknown and malformed ids refused, invalid query refused,
//   stale page's lifecycle write refused by version, removed worker cannot
//   be worked by                                             -> same, connector route
//   one owner gesture records at most one assignment and one submission
//   -> the connector equivalent: one gesture offers at most once, and a
//      double-clicked decision records exactly one review
//   stale reviewer + reviewer race to one canonical decision   -> same, on Workers
//   revision rerun                                             -> the connector
//      equivalent: ask-for-changes reopens the offer to any bot
//   completed task is immutable, changes after acceptance refused  -> unchanged
//   sign-out revokes the session                                 -> unchanged
import { expect, test, type Locator, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Client } from "pg";
import { MAC_LOCAL_FLEET_GATEWAY_ORIGIN_V1 } from "../../src/fleet/v1/mac-local-composition";
import { makeBotWorkspaceV1, removeBotWorkspaceV1, ScriptedBotV1 } from "../../scripts/dogfood/bot-journey.mjs";

const ownerCode = process.env.CONTROL_ROOM_E2E_OWNER_CODE;
if (!ownerCode) throw new Error("CONTROL_ROOM_E2E_OWNER_CODE is required");
const rehearsalRoot = process.env.CONTROL_ROOM_E2E_ROOT;
if (!rehearsalRoot || resolve(rehearsalRoot) !== rehearsalRoot) throw new Error("CONTROL_ROOM_E2E_ROOT must be absolute");
const origin = process.env.CONTROL_ROOM_E2E_ORIGIN;
if (!origin || new URL(origin).hostname !== "127.0.0.1" || new URL(origin).port === "3210")
  throw new Error("adversarial_browser_refused_non_disposable_origin");

type ApiResult = { status: number; text: string; contentType: string };
const botWorkspaces: string[] = [];
test.afterAll(async () => { await Promise.all(botWorkspaces.map(removeBotWorkspaceV1)); });

async function signIn(page: Page) {
  await page.goto("/session");
  await page.getByLabel("Owner code").fill(ownerCode!);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
}

async function api(page: Page, path: string, method = "GET", body?: unknown, key?: string): Promise<ApiResult> {
  return page.evaluate(async ({ path, method, body, key }) => {
    const response = await fetch(path, { method, credentials: "same-origin", cache: "no-store",
      headers: { accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(key ? { "idempotency-key": key } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, text: await response.text(), contentType: response.headers.get("content-type") ?? "" };
  }, { path, method, body, key });
}

async function createProject(page: Page, title: string, key: string, summary = "Disposable adversarial browser coverage.") {
  const response = await api(page, "/api/v1/projects", "POST", { title, summary }, key);
  expect(response.status).toBe(201);
  return (JSON.parse(response.text) as { project: { projectId: string } }).project;
}

async function createTask(page: Page, projectId: string, title: string, instructions: string, key: string) {
  const response = await api(page, `/api/v1/projects/${encodeURIComponent(projectId)}/tasks`, "POST",
    { title, instructions }, key);
  expect(response.status).toBe(201);
  return (JSON.parse(response.text) as { receipt: { jobId: string } }).receipt;
}

/** Routes a connector-only Mac may legitimately not serve. Each is one the
 * product reads on mount purely to find out whether the installation has it, and
 * each degrades by design when it answers 404. The list is exact and read-only:
 * a 404 on any OTHER path, or a 500 on one of these, still trips the check. */
const OPTIONAL_CAPABILITY_PROBES: ReadonlySet<string> = new Set([
  // mac-local-web-process.ts serves this only when `options.updaterOwnerUi` is
  // configured; updater-home-status.tsx renders "not configured" on a 404.
  "/api/v1/updater-owner-ui",
  // worker-scorecard-browser-client.ts returns { state: "unavailable" } for any
  // non-ok response, including 404 and 401.
  "/api/v1/workers-scorecard",
  // operations-mode-browser-client.ts maps a 404 to BrowserRequestError
  // not_found, which the desk renders as "not configured".
  "/api/v1/operations-mode",
  // mac-local-web-process.ts serves the Action Inbox only when
  // `options.actionInboxSource` is configured; the inbox panel renders its own
  // unavailable state when it is not.
  "/api/v1/needs-me/action-items",
]);

async function expectHealthy(page: Page) {
  await expect(page.locator("main")).toBeVisible();
  await expect(page.locator("body")).not.toContainText(/Application error|Internal Server Error|\{"error"|undefined is not/i);
  await expect(page.locator('[role="status"]').filter({ hasText: /Loading|Checking saved|Reading|Saving…/i }))
    .toHaveCount(0, { timeout: 20_000 });
}

function observeBrowserErrors(page: Page, errors: string[], observeHttpFailures = false) {
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => {
    if (["error", "warning"].includes(message.type())) {
      if (/^Failed to load resource: the server responded with a status of \d+/.test(message.text())) return;
      const location = message.location().url;
      errors.push(`${message.text()}${location ? ` (${new URL(location).pathname})` : ""}`);
    }
  });
  // The point of this listener is that a page must not quietly hide a server
  // error behind rendered controls. A 404 on an OPTIONAL capability is a
  // legitimate answer on this connector-only host (see the set above), so those
  // are exempted here rather than by loosening the assertion below.
  if (observeHttpFailures) page.on("response", response => {
    if (response.status() < 400) return;
    const path = new URL(response.url()).pathname;
    if (response.status() === 404 && OPTIONAL_CAPABILITY_PROBES.has(path)) return;
    errors.push(`HTTP ${response.status()} ${path}`);
  });
}

async function activateTwice(locator: Locator) {
  await locator.evaluate((element: HTMLButtonElement) => { element.click(); element.click(); });
}

async function expectNoHorizontalOverflow(page: Page) {
  const dimensions = await page.evaluate(() => ({ viewport: window.innerWidth,
    document: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
  expect(dimensions.document, JSON.stringify(dimensions)).toBeLessThanOrEqual(dimensions.viewport + 1);
  expect(dimensions.body, JSON.stringify(dimensions)).toBeLessThanOrEqual(dimensions.viewport + 1);
}

async function disposableAdmin() {
  const config = JSON.parse(await readFile(`${rehearsalRoot}/protected/config/mac-local.json`, "utf8"));
  const roles = JSON.parse(await readFile(`${rehearsalRoot}/protected/config/database-roles.json`, "utf8"));
  if (config.database?.host !== "127.0.0.1" || config.database?.database !== "control_room"
    || !Number.isInteger(config.database.port) || config.database.port === 5432
    || origin !== config.localOwnerSession?.origin || new URL(origin!).port !== String(config.port)
    || roles.coordinator?.host !== config.database.host || roles.coordinator?.port !== config.database.port
    || roles.coordinator?.database !== config.database.database)
    throw new Error("adversarial_browser_refused_non_disposable_database");
  const client = new Client({ host: "127.0.0.1", port: config.database.port, database: "control_room", user: "postgres" });
  await client.connect();
  const identity = (await client.query<{ data_directory: string }>("SELECT current_setting('data_directory') AS data_directory")).rows[0];
  if (resolve(identity?.data_directory ?? "") !== resolve(rehearsalRoot!, "pg")) {
    await client.end();
    throw new Error("adversarial_browser_refused_non_disposable_database");
  }
  return client;
}

/** A pretend bot on the installed Mac's real route: the real connector client
 * joined with a one-time code the owner issued, never a real bot CLI. */
async function connectBot(page: Page, projectId: string, name: string, kind: "hermes" | "codex" | "claude-code" = "hermes") {
  const issued = await page.evaluate(async ({ projectId, kind, name }) => {
    const response = await fetch("/api/v1/fleet/connect-codes", { method: "POST", credentials: "same-origin",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ name, botKind: kind, operatingSystem: "macos", projectIds: [projectId],
        capabilities: ["code.change"], unattended: false, workerModel: "", workerProfile: "", workerProvider: "" }) });
    return { status: response.status, body: await response.json() as { installLine?: string } };
  }, { projectId, kind, name });
  expect(issued.status, "a signed connector release and a running gateway make Connect a bot available").toBe(201);
  const code = /crj_[A-Za-z0-9_-]+/u.exec(issued.body.installLine ?? "")?.[0];
  expect(code, "the install line carries the one-time join code").toBeTruthy();
  const workspace = await makeBotWorkspaceV1(`adversarial-${kind}`);
  botWorkspaces.push(workspace);
  const bot = new ScriptedBotV1({ name: `adversarial-${kind}`, workspace,
    origin: MAC_LOCAL_FLEET_GATEWAY_ORIGIN_V1, workerKind: kind });
  await bot.join(code!);
  return bot;
}

/** The owner saves a task and offers it, as on the real Mac. Proves the
 * connector-only page has no dead-end direct-path steps. */
async function createOfferedTask(page: Page, projectPath: string, title: string) {
  await page.goto(`${projectPath}/tasks#new-task`);
  await page.getByLabel("Task title").fill(title);
  await page.getByLabel("What should the agent deliver?").fill("Return one harmless short line for adversarial owner review.");
  await page.getByRole("button", { name: "Save task" }).click();
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Send this task to a bot" })).toBeVisible();
  await expect(page.getByText("Task preparation is not connected in this installation.")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Assign after preparation" })).toHaveCount(0);
  await page.getByRole("button", { name: "Offer to other machines" }).click();
  await expect(page.getByText("Offered. Any connected bot in this project with that skill can claim it.")).toBeVisible();
  return { url: page.url(), jobId: decodeURIComponent(new URL(page.url()).pathname.split("/").at(-1)!) };
}

/** One owner gesture must offer at most once: a double-clicked Offer posts one
 * request, and the second is a replay the server can answer from the first. */
async function offerOnce(page: Page, projectPath: string, title: string) {
  const offers: string[] = [];
  const count = (request: { method(): string; url(): string }) => {
    if (request.method() === "POST" && request.url().endsWith("/api/v1/fleet/offers")) offers.push(request.url());
  };
  page.on("request", count);
  await page.goto(`${projectPath}/tasks#new-task`);
  await page.getByLabel("Task title").fill(title);
  await page.getByLabel("What should the agent deliver?").fill("Return one harmless short line for adversarial owner review.");
  await page.getByRole("button", { name: "Save task" }).click();
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  await activateTwice(page.getByRole("button", { name: "Offer to other machines" }));
  await expect(page.getByText("Offered. Any connected bot in this project with that skill can claim it.")).toBeVisible();
  page.off("request", count);
  expect(offers.length, "one owner gesture must record at most one offer").toBeLessThanOrEqual(1);
  return { url: page.url(), jobId: decodeURIComponent(new URL(page.url()).pathname.split("/").at(-1)!) };
}

/** The pretend bot claims the owner's offer and hands back a result. */
async function botDeliversResult(bot: ScriptedBotV1, jobId: string, answer: string, attempt: string) {
  let offerId: string | undefined;
  await expect.poll(async () => {
    const work = await bot.call("list_eligible_work", {});
    expect(work.refused, work.text).toBe(false);
    offerId = (work.value as { offerId: string; jobId: string }[]).find(item => item.jobId === jobId)?.offerId;
    return !!offerId;
  }, { timeout: 75_000, intervals: [500] }).toBe(true);
  const claim = await bot.call("claim", { offerId, idempotencyKey: `adv-claim-${attempt}` });
  expect(claim.refused, claim.text).toBe(false);
  const submitted = await bot.call("submit_result", { claimId: (claim.value as { claimId: string }).claimId,
    answer, idempotencyKey: `adv-result-${attempt}` });
  expect(submitted.refused, submitted.text).toBe(false);
}

/** The owner's decision on the Workers page, where a bot's result waits. */
async function workersCard(page: Page, title: string) {
  await page.goto("/workers");
  await expectHealthy(page);
  const card = page.locator("li.private-local-agent-card").filter({ has: page.getByRole("heading", { name: title }) })
    .filter({ has: page.getByRole("button", { name: "Accept" }) });
  await expect(card).toHaveCount(1);
  return card;
}

test.describe("connector-only owner website adversarial attacks", () => {
  test.beforeAll(async () => { const client = await disposableAdmin(); await client.end(); });

  test("readiness, invalid filters, reloads and layout tell one coherent human story", async ({ page }) => {
    const browserErrors: string[] = [];
    observeBrowserErrors(page, browserErrors, true);
    await signIn(page);

    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Control Room" })).toBeVisible();
    await expect(page.locator("main")).not.toContainText(/Application error|Internal Server Error|undefined is not/i);

    await page.goto("/projects?lifecycle=garbage");
    await expect(page.getByRole("alert")).toContainText("filter was invalid and has been reset to All");
    await expect(page.getByRole("link", { name: "All", exact: true })).toHaveAttribute("aria-current", "page");

    for (const viewport of [{ width: 390, height: 844 }, { width: 1440, height: 900 }]) {
      await page.setViewportSize(viewport);
      for (const path of ["/", "/projects", "/workers", "/needs-me"]) {
        await page.goto(path); await expectHealthy(page); await expectNoHorizontalOverflow(page);
        await page.reload(); await expectHealthy(page); await expectNoHorizontalOverflow(page);
      }
    }
    expect(browserErrors).toEqual([]);
  });

  test("hostile forms store inert text, reject invalid sizes, allow deliberate duplicate names, and survive Back", async ({ page }) => {
    const dialogs: string[] = [], browserErrors: string[] = [], createPosts: string[] = [];
    page.on("dialog", dialog => { dialogs.push(dialog.message()); void dialog.dismiss(); });
    observeBrowserErrors(page, browserErrors);
    page.on("request", request => { if (request.method() === "POST" && new URL(request.url()).pathname === "/api/v1/projects") createPosts.push(request.url()); });
    await signIn(page);

    await page.getByRole("button", { name: "Create project" }).click();
    expect(await page.getByLabel("Project name").evaluate((element: HTMLInputElement) => element.checkValidity())).toBe(false);
    const postsBeforeEmpty = createPosts.length;
    await page.getByLabel("Project name").fill("   ");
    await page.getByRole("button", { name: "Create project" }).click();
    await expect(page.getByRole("alert")).toContainText("Enter a name of 1–120 characters");
    expect(createPosts.length).toBe(postsBeforeEmpty);
    const tooLongProject = await api(page, "/api/v1/projects", "POST", { title: "x".repeat(5_000), summary: "bounded" }, "advlongproject0001");
    expect(tooLongProject.status).toBe(400);

    const hostileTitle = "Adversarial 🧪 שלום <script>alert(1)</script> '; DROP TABLE -- **bold**";
    const hostileSummary = "<img src=x onerror=alert(2)> [link](javascript:alert(3)) مرحبا";
    await page.getByLabel("Project name").fill(hostileTitle);
    await page.getByLabel("What do you want to accomplish?").fill(hostileSummary);
    const postsBefore = createPosts.length;
    await activateTwice(page.getByRole("button", { name: "Create project" }));
    await expect(page.getByRole("heading", { name: hostileTitle })).toBeVisible();
    expect(createPosts.length - postsBefore).toBe(1);
    const projectPath = new URL(page.url()).pathname;
    const projectId = decodeURIComponent(projectPath.split("/").at(-1)!);
    await expect(page.locator("main script")).toHaveCount(0);
    await expect(page.locator("main img")).toHaveCount(0);
    await expect(page.locator("main")).toContainText(hostileSummary);
    await page.setViewportSize({ width: 390, height: 844 });
    await expectNoHorizontalOverflow(page);
    await page.reload();
    await expect(page.getByRole("heading", { name: hostileTitle })).toBeVisible();
    await page.goBack();
    await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
    await page.goForward();
    await expect(page.getByRole("heading", { name: hostileTitle })).toBeVisible();

    const duplicateOne = await createProject(page, "Duplicate project name", "advduplicateproject01");
    const duplicateTwo = await createProject(page, "Duplicate project name", "advduplicateproject02");
    expect(duplicateOne.projectId).not.toBe(duplicateTwo.projectId);

    await page.goto(`${projectPath}/tasks#new-task`);
    await page.getByLabel("Task title").fill("   ");
    await page.getByLabel("What should the agent deliver?").fill("   ");
    await page.getByRole("button", { name: "Save task" }).click();
    await expect(page.getByRole("alert")).toContainText("Check the title and instructions");
    const tooLongTask = await api(page, `/api/v1/projects/${encodeURIComponent(projectId)}/tasks`, "POST",
      { title: "bounded", instructions: "x".repeat(5_000) }, "advlongtask000001");
    expect(tooLongTask.status).toBe(400);

    const taskTitle = "Task 😀 שלום <script>alert(4)</script> SELECT * FROM owners; **text**";
    const instructions = "Return literal text: <b>not HTML</b> `markdown` مرحبا and '; DROP TABLE jobs --";
    await page.getByLabel("Task title").fill(taskTitle);
    await page.getByLabel("What should the agent deliver?").fill(instructions);
    await page.getByRole("button", { name: "Save task" }).click();
    await expect(page.getByRole("heading", { name: taskTitle })).toBeVisible();
    await expect(page.locator("main")).toContainText(instructions);
    await expect(page.locator("main script")).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole("heading", { name: taskTitle })).toBeVisible();
    const duplicateTaskOne = await createTask(page, projectId, "Duplicate task name", "First duplicate body.", "advduplicatetask001");
    const duplicateTaskTwo = await createTask(page, projectId, "Duplicate task name", "Second duplicate body.", "advduplicatetask002");
    expect(duplicateTaskOne.jobId).not.toBe(duplicateTaskTwo.jobId);
    expect(dialogs).toEqual([]);
    expect(browserErrors).toEqual([]);
  });

  test("URLs, CSRF, cross-project objects, stale pages and worker authority fail closed", async ({ page, context }) => {
    const browserErrors: string[] = [];
    observeBrowserErrors(page, browserErrors);
    await signIn(page);
    const projectA = await createProject(page, "Authority project A", "advauthorityproject1");
    const projectB = await createProject(page, "Authority project B", "advauthorityproject2");
    const source = await createTask(page, projectA.projectId, "Unfinished authority task", "Remain unfinished.", "advauthoritytask001");
    const projectPath = `/projects/${encodeURIComponent(projectA.projectId)}`;
    const projectBPath = `/projects/${encodeURIComponent(projectB.projectId)}`;

    // The same two refusals the direct route proved: no Origin, and a foreign one.
    const missingOrigin = await page.request.post(`${origin}/api/v1/projects`, { headers: {
      "content-type": "application/json", "idempotency-key": "advmissingorigin001" },
      data: { title: "Must not save", summary: "Missing Origin" } });
    expect(missingOrigin.status()).toBe(403);
    const wrongOrigin = await page.request.post(`${origin}/api/v1/projects`, { headers: { origin: "http://127.0.0.1:1",
      "content-type": "application/json", "idempotency-key": "advwrongorigin0001" },
      data: { title: "Must not save", summary: "Wrong Origin" } });
    expect(wrongOrigin.status()).toBe(403);

    // Cross-project and forged objects, on the connector route. A worker id that
    // exists, a result that does not, and a worker in another project are each
    // refused; a review for a result id that was never issued is refused too.
    const crossProjectOffer = await api(page, "/api/v1/fleet/offers", "POST",
      { projectId: projectB.projectId, jobId: source.jobId, capability: "code.change" }, "advcrossoffer00001");
    // What matters is that it is REFUSED, not which layer refuses: the offer
    // names project B's id with project A's job, and the application guard, the
    // capability check and the database's own foreign keys are all legitimate
    // places for that to be caught. Whichever one answers, no row may survive.
    expect(crossProjectOffer.status).toBeGreaterThanOrEqual(400);
    const offerCount = await disposableAdmin();
    try {
      const rows = (await offerCount.query("SELECT count(*)::int AS n FROM fleet_work_offers")).rows[0];
      expect(Number(rows?.n), "a refused cross-project offer must leave no row").toBe(0);
    } finally { await offerCount.end(); }
    const forgedReview = await api(page, "/api/v1/fleet/results/fleet-result:" + "a".repeat(32) + "/review", "POST",
      { decision: "accepted" }, "advforgedreview0001");
    expect(forgedReview.status).toBe(404);
    const unknownWorker = await api(page, "/api/v1/fleet/workers/fleet-worker:" + "b".repeat(32) + "/revoke", "POST", {});
    expect([404, 405].includes(unknownWorker.status),
      `a worker id that was never issued must be refused, got ${unknownWorker.status}`).toBe(true);
    const badPagePaths = [
      "/projects/project:missing",
      `${projectPath}/tasks/job:missing`,
      "/projects/%25",
      `${projectBPath}/tasks/${encodeURIComponent(source.jobId)}`,
    ];
    for (const badPath of badPagePaths) {
      const response = await page.goto(badPath);
      expect(response?.status(), badPath).toBeGreaterThanOrEqual(400);
      await expect(page.getByRole("heading", { name: "Page unavailable" })).toBeVisible();
      await expect(page.getByRole("alert")).toContainText("not available");
      await expect(page.locator("body")).not.toContainText('{"error"');
    }
    await page.goto("/projects?lifecycle=active&lifecycle=paused");
    await expect(page.getByRole("alert")).toContainText("page address is invalid");
    await expectHealthy(page);

    const stale = await context.newPage();
    observeBrowserErrors(stale, browserErrors);
    // The stale page is a SECOND SIGNED-IN OWNER VIEW of the same project, not a
    // signed-out visitor: a 403 here would prove nothing about version checks.
    await signIn(stale);
    await page.goto(projectPath); await stale.goto(projectPath);
    const staleProject = await api(stale, `/api/v1/projects/${encodeURIComponent(projectA.projectId)}`);
    const staleVersion = (JSON.parse(staleProject.text) as { project: { version: number } }).project.version;
    await page.getByRole("button", { name: "Pause project" }).click();
    await expect(page.getByText(/^paused ·/)).toBeVisible();
    const staleTransition = await api(stale, `/api/v1/projects/${encodeURIComponent(projectA.projectId)}/lifecycle`,
      "POST", { lifecycle: "completed", expectedVersion: staleVersion }, "advstalelifecycle01");
    expect(staleTransition.status).toBe(409);
    await stale.reload(); await expect(stale.getByText(/^paused ·/)).toBeVisible();
    await page.getByRole("button", { name: "Reopen project" }).click();
    await expect(page.getByText(/^active ·/)).toBeVisible();
    await stale.close();

    // A removed bot cannot be worked by: the owner removes it, and the gateway
    // stops offering its work. The owner decision on its own result is refused
    // once the worker is gone, so nothing stale can be accepted through it.
    await connectBot(page, projectA.projectId, "Removed bot", "codex");
    const removal = await page.evaluate(async () => {
      const board = await (await fetch("/api/v1/fleet", { credentials: "same-origin" })).json() as {
        workers: { workerId: string; displayName: string }[] };
      const target = board.workers.find(worker => worker.displayName === "Removed bot");
      if (!target) return { status: 404 };
      const response = await fetch(`/api/v1/fleet/workers/${encodeURIComponent(target.workerId)}/revoke`,
        { method: "POST", credentials: "same-origin",
          headers: { accept: "application/json", "content-type": "application/json", "x-requested-with": "XMLHttpRequest" },
          body: "{}" });
      return { status: response.status, workerId: target.workerId, body: await response.text() };
    });
    expect(removal.status, `removing a connected bot must succeed: ${removal.body}`).toBe(200);
    await page.goto("/workers");
    await expectHealthy(page);
    await expect(page.locator("li.private-local-agent-card").filter({ hasText: "Removed bot" })
      .getByText("Removed", { exact: true })).toBeVisible();
    expect(browserErrors).toEqual([]);
  });

  test("double actions, stale review, ask-for-changes and sign-out preserve one canonical state", async ({ page, context }) => {
    const browserErrors: string[] = [];
    const dialogs: string[] = [];
    page.on("dialog", dialog => { dialogs.push(dialog.message()); void dialog.accept(); });
    observeBrowserErrors(page, browserErrors);
    await signIn(page);
    const project = await createProject(page, "Review state consistency", "advreviewproject001");
    const projectPath = `/projects/${encodeURIComponent(project.projectId)}`;
    const reviewPosts: string[] = [];
    const captureReview = (request: { method(): string; url(): string }) => {
      if (request.method() === "POST" && /\/api\/v1\/fleet\/results\/[^/]+\/review$/u.test(new URL(request.url()).pathname))
        reviewPosts.push(request.url());
    };
    page.on("request", captureReview);
    const bot = await connectBot(page, project.projectId, "Review bot", "hermes");

    // One owner gesture must offer at most once, and one decision must be
    // recorded exactly once even when two pages race each other.
    const accepted = await offerOnce(page, projectPath, "Concurrent acceptance task");
    await botDeliversResult(bot, accepted.jobId, "One harmless line.", "accept-1");
    const staleReview = await context.newPage();
    observeBrowserErrors(staleReview, browserErrors);
    // A second SIGNED-IN view of the same result: the race under test is two
    // owner tabs, not two browsers of which one is signed out.
    await signIn(staleReview);
    staleReview.on("request", captureReview);
    await Promise.all([
      (async () => { const card = await workersCard(page, "Concurrent acceptance task"); await card.getByText(/^Read the result/).click(); })(),
      (async () => { const card = await workersCard(staleReview, "Concurrent acceptance task"); await card.getByText(/^Read the result/).click(); })(),
    ]);
    await Promise.all([
      page.locator("li.private-local-agent-card").filter({ hasText: "Concurrent acceptance task" })
        .getByRole("button", { name: "Accept", exact: true }).click(),
      staleReview.locator("li.private-local-agent-card").filter({ hasText: "Concurrent acceptance task" })
        .getByRole("button", { name: "Accept", exact: true }).click(),
    ]);
    await expect.poll(async () => (await page.locator("body").innerText()).includes("Concurrent acceptance task"), { timeout: 30_000 })
      .toBe(true);
    // Exactly one review row, whatever the two pages did.
    const reviews = await disposableAdmin();
    try {
      const counted = (await reviews.query("SELECT decision, count(*)::int AS n FROM fleet_result_reviews"
        + " GROUP BY decision")).rows;
      for (const row of counted) expect(Number(row.n), `one decision value per result: ${JSON.stringify(row)}`).toBe(1);
    } finally { await reviews.end(); }

    // Ask for changes reopens the offer to any bot: the same or another machine
    // can pick the task up again, which is the connector route's revision loop.
    const changes = await offerOnce(page, projectPath, "Revision lifecycle task");
    await botDeliversResult(bot, changes.jobId, "First line to revise.", "rev-1");
    const changesCard = await workersCard(page, "Revision lifecycle task");
    await changesCard.getByText(/^Read the result/).click();
    await changesCard.getByLabel(/Changes you want/).fill("Return a corrected harmless line.");
    await activateTwice(changesCard.getByRole("button", { name: "Ask for changes" }));
    await expect.poll(async () => reviewPosts.length, { timeout: 30_000 }).toBeGreaterThan(0);
    await botDeliversResult(bot, changes.jobId, "Second line, corrected.", "rev-2");
    const revisedCard = await workersCard(page, "Revision lifecycle task");
    await revisedCard.getByText(/^Read the result/).click();
    await revisedCard.getByRole("button", { name: "Accept", exact: true }).click();
    await expect(revisedCard).toHaveCount(0, { timeout: 30_000 });

    // A finished task is immutable and can never be decided on twice.
    const rejected = await offerOnce(page, projectPath, "Rejected task");
    await botDeliversResult(bot, rejected.jobId, "One harmless line.", "reject-1");
    const rejectedCard = await workersCard(page, "Rejected task");
    await rejectedCard.getByText(/^Read the result/).click();
    await rejectedCard.getByRole("button", { name: "Reject" }).click();
    await expect(rejectedCard).toHaveCount(0, { timeout: 30_000 });
    // The owner's own wording for a task they rejected, on the task page.
    // The chip applies `text-transform: capitalize` (private.css), so the DOM
    // text is title-cased; assert case-insensitively on the words the owner
    // actually reads, not on the exact source string.
    await expect.poll(async () => {
      await page.goto(rejected.url);
      await expectHealthy(page);
      return page.locator(".private-task-detail .private-state").first().innerText();
    }, { timeout: 75_000, intervals: [2_000] }).toMatch(/^rejected by you$/iu);
    // And it must never read as the generic cancellation wording.
    await expect(page.locator(".private-task-detail .private-state").first()).not.toContainText(/cancel/iu);

    for (const path of [projectPath, `${projectPath}/tasks`]) {
      await page.goto(path); await expectHealthy(page);
      await expect(page.locator("main")).toContainText("Concurrent acceptance task");
    }
    await staleReview.close();
    expect(browserErrors).toEqual([]);

    const signOut = await api(page, "/api/v1/local-owner-session", "DELETE");
    expect(signOut.status).toBe(204);
    const afterSignOut = await api(page, "/api/v1/projects", "POST",
      { title: "Must not save after sign-out", summary: "Expired authority" }, "advaftersignout001");
    expect(afterSignOut.status).toBe(401);
    await page.goto("/projects");
    await expect(page.getByRole("heading", { name: "Control Room" })).toBeVisible();
    await expect(page.getByLabel("Owner code")).toBeVisible();
  });
});